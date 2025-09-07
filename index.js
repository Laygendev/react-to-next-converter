#!/usr/bin/env node
    
const sizeOf = require('image-size');
const fs = require('fs').promises;
const path = require('path');
const { glob } = require('glob');

// --- FONCTIONS UTILITAIRES ---
async function copyRecursive(src, dest) {
    try {
        const stats = await fs.stat(src);
        if (stats.isDirectory()) {
            await fs.mkdir(dest, { recursive: true });
            for (const child of await fs.readdir(src)) {
                await copyRecursive(path.join(src, child), path.join(dest, child));
            }
        } else {
            await fs.copyFile(src, dest);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

async function fileExists(filePath) {
    return !!(await fs.stat(filePath).catch(() => false));
}

// --- FONCTIONS DE CONFIGURATION NEXT.JS ---
async function updatePackageJson(projectPath) {
    const packageJsonPath = path.join(projectPath, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    delete packageJson.devDependencies['@vitejs/plugin-react-swc'];
    delete packageJson.devDependencies['vite'];
    packageJson.dependencies['react'] = '^18';
    packageJson.dependencies['react-dom'] = '^18';
    packageJson.dependencies['next'] = '^14.2.0';
    packageJson.scripts = {
        "dev": "next dev",
        "build": "next build",
        "start": "next start",
        "lint": "next lint"
    };
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
}

async function createNextConfig(projectPath) {
    const nextConfigContent = `
/** @type {import('next').NextConfig} */
const nextConfig = {
    images: {
        remotePatterns: [
            { protocol: 'https', hostname: 'images.unsplash.com' },
        ],
    },
};
export default nextConfig;`;
    await fs.writeFile(path.join(projectPath, 'next.config.mjs'), nextConfigContent.trim());
}

async function createTsConfig(projectPath) {
    const tsconfigContent = {
        "compilerOptions": {
            "target": "es5", "lib": ["dom", "dom.iterable", "esnext"], "allowJs": true,
            "skipLibCheck": true, "strict": true, "noEmit": true, "esModuleInterop": true,
            "module": "esnext", "moduleResolution": "bundler", "resolveJsonModule": true,
            "isolatedModules": true, "jsx": "preserve", "incremental": true,
            "plugins": [{ "name": "next" }],
            "paths": { "@/*": ["./app/*"] }
        },
        "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
        "exclude": ["node_modules"]
    };
    await fs.writeFile(path.join(projectPath, 'tsconfig.json'), JSON.stringify(tsconfigContent, null, 2));
}

// --- FONCTIONS DE TRANSFORMATION DU CODE ---
async function handleStaticAssets(projectPath) {
    const appPath = path.join(projectPath, 'app');
    const assetsPath = path.join(appPath, 'assets');
    const publicPath = path.join(appPath, 'public');
    const publicAssetsPath = path.join(publicPath, 'assets');
    await fs.mkdir(publicPath, { recursive: true });
    
    if (await fileExists(assetsPath)) {
        await copyRecursive(assetsPath, publicAssetsPath);
        await fs.rm(assetsPath, { recursive: true, force: true });
    }
    const files = await glob(`${appPath}/**/*.tsx`);
    for (const file of files) {
        let content = await fs.readFile(file, 'utf8');
        content = content.replace(/from\s+['"]figma:asset\/(.*?)['"]/g, `from '@/public/assets/$1'`);
        await fs.writeFile(file, content, 'utf8');
    }
}

async function removeVersionFromImports(appPath) {
    const files = await glob(`${appPath}/**/*.tsx`);
    for (const file of files) {
        let content = await fs.readFile(file, 'utf8');
        content = content.replace(/(from\s+['"])([^'"]+)@[\d.v^-]+(['"])/g, '$1$2$3');
        await fs.writeFile(file, content, 'utf8');
    }
}

async function updateAllImportPaths(appPath) {
    const files = await glob(`${appPath}/**/*.tsx`);
    for (const file of files) {
        let content = await fs.readFile(file, 'utf8');
        content = content.replace(/from\s+['"]((\.\.\/)+)([^'"]+)['"]/g, (match, fullRelative, dots, restOfPath) => {
            if (restOfPath.startsWith('components/')) {
                return `from '@/${restOfPath}'`;
            } else {
                return `from '@/components/${restOfPath}'`;
            }
        });
        await fs.writeFile(file, content, 'utf8');
    }
}


// REMPLACEZ LA FONCTION transformSourceFiles EXISTANTE PAR CELLE-CI
async function transformSourceFiles(projectPath) {
    const appPath = path.join(projectPath, 'app');
    const allFiles = await glob(`${appPath}/**/*.{ts,tsx}`);

    for (const file of allFiles) {
        let content = await fs.readFile(file, 'utf8');
        const originalContent = content;

        // --- PASSE 0: RÉPARATION DES ERREURS PRÉCÉDENTES (SÉCURITÉ) ---
        content = content.replace(/onClick\?\s*=>\s*void/g, 'onClick?: () => void');
        content = content.replace(/(export\s+(?:default\s+)?function\s+\w+\s*\()\)\)/g, '$1)');

        // --- PASSE 1: TRANSFORMER LES COMPOSANTS UTILISÉS POUR LA NAVIGATION ---
        content = content.replace(
            /<(CTAButton|Button)([^>]*?)onClick={onNavigateToContact}([^>]*?)>([\s\S]*?)<\/\1>/g,
            (match, Comp, propsBefore, propsAfter, children) => {
                return `<Link href="/contact" passHref><${Comp}${propsBefore}${propsAfter}>${children}</${Comp}></Link>`;
            }
        );

        // --- PASSE 2: NETTOYAGE COMPLET DU SYSTÈME DE PROPS "onNavigateTo..." ---
        // A. Nettoyer les appels de composants
        content = content.replace(/\s+onNavigateTo\w+={[^}]+}/g, '');
        // B. Nettoyer les signatures de fonction (approche par ligne)
        content = content.replace(
            /(export\s+(?:default\s+)?function\s+\w+\s*\()({[\s\S]+?})(\)\s*\{)/g,
            (match, start, propsBlock, end) => {
                if (!propsBlock.includes('onNavigateTo')) return match;
                const lines = propsBlock.split('\n');
                const filteredLines = lines.filter(line => !line.includes('onNavigateTo'));
                let newPropsBlock = filteredLines.join('\n');
                if (newPropsBlock.replace(/[{},\s\n]/g, '') === '') {
                    return `${start}${end}`;
                }
                return `${start}${newPropsBlock}${end}`;
            }
        );
        // C. Nettoyer les `interface` ou `type` definitions
        content = content.replace(/^\s*onNavigateTo\w+:\s*\([\s\S]*?;\s*$/gm, '');

        // --- NOUVEAU - PASSE 3: MODERNISER LES IMAGES <img> -> <Image> ---
        // --- PASSE 3: MODERNISER LES IMAGES <img> -> <Image> AVEC DIMENSIONS ---
        if (content.includes('<img')) {
            content = content.replace(/<img([\s\S]*?)\/?>/g, (match, attributes) => {
                const hasWidth = /width\s*=\s*['"{]/.test(attributes);
                const hasHeight = /height\s*=\s*['"{]/.test(attributes);

                if (hasWidth && hasHeight) {
                    return `<Image${attributes}/>`;
                }

                const srcMatch = attributes.match(/src\s*=\s*(?:['"]([^'"]+)['"]|{([^}]+)})/);
                if (!srcMatch) return match; // Garder l'original si pas de src
                
                const src = srcMatch[1] || srcMatch[2]; // src peut être une chaîne ou une variable
                let dimensionsAttr = '';

                if (src.startsWith('/')) { // Image locale
                    try {
                        const imagePath = path.join(projectPath, 'public', src);
                        const dimensions = sizeOf(imagePath);
                        if (!hasWidth) dimensionsAttr += ` width={${dimensions.width}}`;
                        if (!hasHeight) dimensionsAttr += ` height={${dimensions.height}}`;
                    } catch (error) {
                        console.warn(`  [Attention] Impossible de trouver les dimensions pour: ${src}. Ajout de dimensions par défaut.`);
                        if (!hasWidth) dimensionsAttr += ` width={500} /* TODO: Vérifier dimensions locales */`;
                        if (!hasHeight) dimensionsAttr += ` height={500}`;
                    }
                } 
                else if (src.startsWith('http')) { // Image externe
                     if (!hasWidth) dimensionsAttr += ` width={1200} /* TODO: Vérifier dimensions externes */`;
                     if (!hasHeight) dimensionsAttr += ` height={800}`;
                }
                else { // Image importée (ex: src={logoImage})
                    if (!hasWidth) dimensionsAttr += ` width={500} /* TODO: Vérifier dimensions importées */`;
                    if (!hasHeight) dimensionsAttr += ` height={500}`;
                }
                
                return `<Image${attributes}${dimensionsAttr}/>`;
            });
        }

        // --- PASSE 4: FINALISATION (IMPORTS, 'use client', etc.) ---
        content = content.replace(/from 'motion\/react'/g, "from 'framer-motion'");
        
        // Ajout des imports nécessaires
        if (content.includes('<Link') && !content.includes("import Link from 'next/link'")) {
            content = "import Link from 'next/link';\n" + content;
        }
        if (content.includes('<Image') && !content.includes("import Image from 'next/image'")) {
            content = "import Image from 'next/image';\n" + content;
        }

        if (/(useState|useEffect|motion|whileInView|onClick)/.test(content) && !content.trim().startsWith("'use client'")) {
            content = "'use client';\n\n" + content;
        }
        if (file.endsWith('page.tsx') && !content.includes('export default function')) {
            content = content.replace(/export function (\w+)/, 'export default function $1');
        }

        if (content !== originalContent) {
            await fs.writeFile(file, content, 'utf8');
        }
    }
}

async function createNextJsLayout(appPath) {
    const appTsxPath = path.join(appPath, 'App.tsx');
    const layoutTsxPath = path.join(appPath, 'layout.tsx');

    // ÉTAPE 1: GÉRER L'ABSENCE DU FICHIER SOURCE
    if (!await fileExists(appTsxPath)) {
        console.warn("[Attention] 'App.tsx' non trouvé. Création d'un layout minimaliste.");
        const fallbackLayout = `import "./globals.css";\nexport default function RootLayout({ children }) { return <html lang="en"><body>{children}</body></html>; }`;
        await fs.writeFile(layoutTsxPath, fallbackLayout);
        await fs.writeFile(path.join(appPath, 'globals.css'), '/* Styles globaux */');
        return;
    }

    console.log("Conversion finale de 'App.tsx' en 'layout.tsx'...");
    let content = await fs.readFile(appTsxPath, 'utf8');

    // --- ÉTAPE 2: EXTRACTION DES BLOCS DE CODE ---
    const allImports = (content.match(/import[\s\S]*?from\s*['"][^'"]+['"];?/g) || []);
    const returnMatch = content.match(/return\s*\(([\s\S]*?)\);/);
    if (!returnMatch) throw new Error("Bloc 'return' non trouvé dans App.tsx.");
    let mainJsx = returnMatch[1];

    // --- ÉTAPE 3: LA TRANSFORMATION CLÉ - ISOLER ET REMPLACER ---
    
    // A. Identifier tous les noms de composants de page depuis les imports
    const pageComponentNames = [];
    const pageImports = allImports.filter(imp => /\/pages\//.test(imp));
    pageImports.forEach(imp => {
        const match = imp.match(/{\s*([^}]+?)\s*}/);
        if (match && match[1]) {
            pageComponentNames.push(...match[1].split(',').map(name => name.trim().split(' ')[0]));
        }
    });
    // On ajoute manuellement d'autres composants non-layout connus
    pageComponentNames.push('MetaTags');

    // B. Remplacer TOUTES les instances de ces composants de page par le placeholder {children}
    // On ne le remplace qu'une seule fois pour éviter d'avoir plusieurs {children}
    let childrenInjected = false;
    for (const pageName of pageComponentNames) {
        const regex = new RegExp(`<${pageName}[\\s\\S]*?(?:\\/>|<\\/${pageName}>)`, 'g');
        mainJsx = mainJsx.replace(regex, (match) => {
            if (!childrenInjected) {
                childrenInjected = true;
                return '<main>{children}</main>'; // Remplacer la première page trouvée par {children}
            }
            return ''; // Supprimer les autres occurrences de pages
        });
    }
    // Si aucune page n'a été trouvée, on supprime le bloc <Routes> s'il existe
    if (!childrenInjected) {
        mainJsx = mainJsx.replace(/<Routes>[\s\S]*?<\/Routes>/gs, '<main>{children}</main>');
    }
    
    // --- ÉTAPE 4: NETTOYAGE DE LA LOGIQUE ET DES PROPS ORPHELINES ---
    content = content.replace(/const\s*{\s*[\s\S]*?}\s*=\s*useAdvancedNavigation\(\);/gs, '');
    content = content.replace(/const\s+(pageSEO|getPageSEO|prestation)\s*=\s*[\s\S]*?;/gs, '');
    mainJsx = mainJsx.replace(/\s+(currentPage|onNavigateTo|onScrollToSection|onBack|prestation|pageSEO)={[^}]+}/g, '');
    mainJsx = mainJsx.replace(/\s+\{\.{3}pageSEO\}/g, '');

    // --- ÉTAPE 5: FILTRAGE FINAL DES IMPORTS ---
    const usedComponents = new Set();
    const jsxTags = mainJsx.match(/<([A-Z]\w*)/g) || [];
    jsxTags.forEach(tag => usedComponents.add(tag.substring(1)));

    const finalImports = allImports.filter(imp => {
        if (/react-router-dom|\/pages\/|\/hooks\/|\/data\/|SEO\/MetaTags/.test(imp)) return false;
        const importMatch = imp.match(/import\s+(?:type\s+)?(?:[\w\s,]*?{\s*([^}]+?)\s*})?/);
        if (importMatch && importMatch[1]) {
            const importedNames = importMatch[1].split(',').map(name => name.trim().split(' ')[0]);
            return importedNames.some(name => usedComponents.has(name));
        }
        return true;
    });

    // --- ÉTAPE 6: RECONSTRUIRE LE FICHIER layout.tsx FINAL ---
    const finalLayoutContent = `
import type { Metadata } from "next";
${finalImports.join('\n')}
import "./globals.css";

export const metadata: Metadata = {
  title: "My Converted Next App",
  description: "Generated by React-to-Next converter",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr">
      <body>
        ${mainJsx}
      </body>
    </html>
  );
}`;

    await fs.writeFile(layoutTsxPath, finalLayoutContent.trim());
    console.log("-> 'layout.tsx' a été créé avec succès.");

    // --- ÉTAPE 7: GESTION DU CSS ---
    const globalsCssPath = path.join(appPath, 'globals.css');
    const oldIndexCssPath = path.join(appPath, 'index.css');
    if (await fileExists(oldIndexCssPath)) {
        await fs.rename(oldIndexCssPath, globalsCssPath);
    } else if (!await fileExists(globalsCssPath)) {
        await fs.writeFile(globalsCssPath, '/* Styles globaux */');
    }
}

async function createNextJsNavigation(componentsPath) {
    const navPath = path.join(componentsPath, 'layout', 'EnhancedNavigation.tsx');
    if (!await fileExists(navPath)) {
        console.log("Fichier de navigation non trouvé, étape ignorée.");
        return;
    }
    
    let content = await fs.readFile(navPath, 'utf8');
    
    console.log("Début de la transformation de EnhancedNavigation.tsx (nouvelle approche)...");

    // --- Étape 1: Nettoyage des éléments React spécifiques à l'ancien système ---
    content = content.replace(/import { PageType } from ['"].*?['"];\n?/g, '');
    content = content.replace(/ as PageType/g, '');
    content = content.replace(/interface EnhancedNavigationProps[\s\S]*?}\n/g, '');
    content = content.replace(
        /export function EnhancedNavigation\s*\({[\s\S]*?}\)/, 
        'export function EnhancedNavigation()'
    );
    content = content.replace(/const {[\s\S]*?useAdvancedNavigation\(\);/, 'const pathname = usePathname();');
    content = content.replace(/currentPage/g, 'pathname');

    // --- Étape 2: Transformer le bouton de navigation simple (le cas qui échoue toujours) ---
    // On cible très spécifiquement CE bouton.
    content = content.replace(
        /<button(\s+onClick=\{\s*\(\)\s*=>\s*handleNavigation\(item\.page\)\s*\}[\s\S]*?)>([\s\S]*?)<\/button>/g,
        (match, props, children) => {
            // On prend toutes les props du bouton, on enlève le onClick, et on le remplace par href.
            const newProps = props.replace(/onClick=\{\s*\(\)\s*=>\s*handleNavigation\(item\.page\)\s*\}/, 'href={`/${item.page}`}');
            return `<Link${newProps}>${children}</Link>`;
        }
    );

    // --- Étape 3: Transformer les <CTAButton> et <Button> ---
    content = content.replace(
        /<(CTAButton|Button)([\s\S]*?)onClick=\{\s*\(\)\s*=>\s*handleNavigation\('([^']+)'\)\}([\s\S]*?)>([\s\S]*?)<\/\1>/g,
        (match, Comp, propsBefore, page, propsAfter, children) => {
            return `<Link href="/${page}" passHref><${Comp}${propsBefore}${propsAfter}>${children}</${Comp}></Link>`;
        }
    );
    
    // --- Étape 4: Transformer les <motion.button> dans les menus ---
    content = content.replace(
        /<(motion\.button)([\s\S]*?)onClick=\{\s*\(\)\s*=>\s*handleNavigation\(([^)]+)\)\}([\s\S]*?)>([\s\S]*?)<\/\1>/g,
        (match, Comp, propsBefore, pageVar, propsAfter, children) => {
            const newProps = propsBefore + propsAfter;
            // Pour motion, on transforme en motion.a et on utilise legacyBehavior
            return `<Link href={\`/\${${pageVar}}\`} passHref legacyBehavior><motion.a${newProps}>${children}</motion.a></Link>`;
        }
    );
    
    // --- Étape 5: Transformer le logo ---
    content = content.replace(
        /<motion\.div([\s\S]*?)onClick=\{\s*\(\)\s*=>\s*handleNavigation\('home'\)\}/s,
        `<Link href="/"><motion.div$1>`
    );
    content = content.replace(
        /(<p className="text-xs text-emerald-600[\s\S]*?<\/p>\s*<\/div>\s*)(<\/motion\.div>)/s,
        `$1</motion.div></Link>`
    );

    // --- Étape 6: Nettoyage final ---
    content = content.replace(/const handleNavigation\s*=\s*\([\s\S]*?};/, '');
    if (!content.includes("import Link from 'next/link'")) {
        content = "import Link from 'next/link';\n" + content;
    }
    if (!content.includes("import { usePathname } from 'next/navigation'")) {
        content = "import { usePathname } from 'next/navigation';\n" + content;
    }
    // if (!content.trim().startsWith("'use client'")) {
    //     content = "'use client';\n\n" + content;
    // }
    content = content.replace(/from 'motion\/react'/g, "from 'framer-motion'");

    await fs.writeFile(navPath, content);
    console.log("✅ Transformation de EnhancedNavigation.tsx terminée.");
}

async function cleanupAfterConversion(destDir) {
    const appPath = path.join(destDir, 'app');
    
    await fs.rm(path.join(appPath, 'App.tsx'), { force: true });
    await fs.rm(path.join(appPath, 'main.tsx'), { force: true });
    if (await fileExists(path.join(appPath, 'hooks'))) await fs.rm(path.join(appPath, 'hooks'), { recursive: true, force: true });
    if (await fileExists(path.join(appPath, 'pages'))) await fs.rm(path.join(appPath, 'pages'), { recursive: true, force: true });
    await fs.rm(path.join(destDir, 'index.html'), { force: true });
    await fs.rm(path.join(destDir, 'vite.config.ts'), { force: true });
}

// --- PROCESSUS PRINCIPAL ---
async function convertProject(sourceDir) {
    const destDir = `${sourceDir}-next`;
    console.log(`Conversion de '${sourceDir}' vers '${destDir}'...`);

    // 1. Copier et configurer
    await copyRecursive(sourceDir, destDir);
    await updatePackageJson(destDir);
    await createNextConfig(destDir);

    // 2. Renommer src -> app
    const oldSrcPath = path.join(destDir, 'src');
    const appPath = path.join(destDir, 'app');
    await fs.rename(oldSrcPath, appPath);
    await createTsConfig(destDir);

    // 3. Transformer le code
    await handleStaticAssets(destDir);
    await removeVersionFromImports(appPath);
    await updateAllImportPaths(appPath);

    // 4. Créer les routes
    const pagesDir = path.join(appPath, 'pages');
    if (await fileExists(pagesDir)) {
        const pageFiles = await fs.readdir(pagesDir);
        for (const pageFile of pageFiles) {
            const pageName = path.parse(pageFile).name.replace('Page', '').toLowerCase();
            const routeName = pageName === 'home' ? '' : pageName;
            const routeDir = path.join(appPath, routeName);
            await fs.mkdir(routeDir, { recursive: true });
            const content = await fs.readFile(path.join(pagesDir, pageFile), 'utf8');
            await fs.writeFile(path.join(routeDir, 'page.tsx'), content);
        }
    }
    
    // 5. Créer Layout, adapter la Navigation, et transformer tout le code
    await createNextJsLayout(appPath);
    await createNextJsNavigation(path.join(appPath, 'components'));
    await transformSourceFiles(destDir);
    
    // 6. Nettoyage final
    await cleanupAfterConversion(destDir);
    
    console.log('\n✅ Conversion terminée avec succès !');
    console.log('\nProchaines étapes :');
    console.log(`  cd ${destDir}`);
    console.log('  npm install');
    console.log('  npm run dev');
}

// --- Exécution ---
const sourceDir = process.argv[2];
if (!sourceDir) {
    console.error('Usage: convert <dossier-du-projet-react>');
    process.exit(1);
}

convertProject(sourceDir).catch(err => {
    console.error('Une erreur est survenue :', err);
    process.exit(1);
});