# Next.js Project Skill

You are building a Next.js application. Follow these instructions exactly.

## Creating a New Next.js Project

### Method 1: Official CLI (preferred)

```
npx create-next-app@latest PROJECT_NAME --yes --tailwind --eslint --app --src-dir --import-alias "@/*"
```

Flags explained:
- `--yes` — skip all interactive prompts (CRITICAL for non-interactive shell)
- `--tailwind` — install Tailwind CSS
- `--eslint` — install ESLint
- `--app` — use App Router (not Pages Router)
- `--src-dir` — put source code in `src/` directory
- `--import-alias "@/*"` — set path alias for imports

If this command hangs or fails, move to Method 2.

### Method 2: Clone a starter template

Search GitHub for a well-maintained template:
```
github_search "nextjs starter template" sort:stars
```

Pick one with high stars and recent updates. Verify it exists with read_url, then clone:
```
github_clone url="https://github.com/OWNER/REPO" destination="PROJECT_NAME" depth=1
```

After cloning, read the README and follow its setup instructions.

### Method 3: Manual creation (last resort)

Create these files in order:

**package.json:**
```json
{
  "name": "PROJECT_NAME",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "next": "^15",
    "react": "^19",
    "react-dom": "^19"
  },
  "devDependencies": {
    "@types/node": "^22",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "typescript": "^5",
    "tailwindcss": "^4",
    "@tailwindcss/postcss": "^4",
    "postcss": "^8",
    "eslint": "^9",
    "eslint-config-next": "^15",
    "@eslint/eslintrc": "^3"
  }
}
```

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

**postcss.config.mjs:**
```js
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
export default config;
```

**src/app/globals.css:**
```css
@import "tailwindcss";
```

**src/app/layout.tsx:**
```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "My App",
  description: "Built with Next.js",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
```

**src/app/page.tsx:**
```tsx
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center">
      <h1 className="text-4xl font-bold">Hello World</h1>
    </main>
  );
}
```

**next.config.ts:**
```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = {};
export default nextConfig;
```

Then install: `cd PROJECT_NAME && npm install`

## App Router Structure

```
src/app/
  layout.tsx        — root layout (wraps all pages, includes <html> and <body>)
  page.tsx          — home page (/)
  loading.tsx       — loading UI (shown while page loads)
  error.tsx         — error boundary ('use client' required)
  not-found.tsx     — 404 page
  about/
    page.tsx        — /about route
  blog/
    page.tsx        — /blog route
    [slug]/
      page.tsx      — /blog/:slug dynamic route
  api/
    route.ts        — API route handler
```

Key rules:
- `layout.tsx` is a Server Component. It wraps children and persists across navigations.
- `page.tsx` is the route content. Every route folder needs one.
- `'use client'` directive at top of file = Client Component (for useState, useEffect, onClick, etc.)
- Without `'use client'` = Server Component (default, runs on server, can async/await, can fetch data directly)

## Components

Put reusable components in `src/components/`:

```
src/components/
  Header.tsx
  Footer.tsx
  Hero.tsx
  Features.tsx
  Testimonials.tsx
  CTA.tsx
  ui/              — base UI components (Button, Card, etc.)
```

## Landing Page Sections

A typical landing page has these sections in order:

1. **Header/Navbar** — logo, navigation links, CTA button
2. **Hero** — main headline, subheadline, CTA button, hero image/illustration
3. **Logos/Social proof** — trusted by X companies
4. **Features** — 3-6 feature cards with icons
5. **How it works** — 3 step process
6. **Testimonials** — customer quotes with photos
7. **Pricing** — pricing tiers (if SaaS)
8. **FAQ** — expandable questions
9. **CTA** — final call to action
10. **Footer** — links, social, copyright

## Tailwind CSS v4

Next.js 15 uses Tailwind v4. Key differences from v3:
- Config is in CSS, not tailwind.config.js: `@import "tailwindcss";`
- PostCSS plugin is `@tailwindcss/postcss`, not `tailwindcss`
- Custom values use CSS variables: `--color-primary: #3b82f6;`
- No need for `tailwind.config.ts` file

## Adding shadcn/ui

```
npx shadcn@latest init -y --defaults
npx shadcn@latest add button card input
```

The `-y` flag skips prompts. Components are installed in `src/components/ui/`.

## Images

Put images in `public/` directory. Reference with `<Image src="/hero.png" />` from `next/image`.

`next/image` requires width and height props, or `fill` with a positioned parent:
```tsx
import Image from "next/image";

// Fixed size
<Image src="/logo.png" width={120} height={40} alt="Logo" />

// Fill parent
<div className="relative h-64 w-full">
  <Image src="/hero.jpg" fill className="object-cover" alt="Hero" />
</div>
```

## Fonts

Use `next/font` for optimized fonts:
```tsx
import { Inter } from "next/font/google";
const inter = Inter({ subsets: ["latin"] });

// In layout.tsx body:
<body className={inter.className}>
```

## Metadata & SEO

In any `layout.tsx` or `page.tsx`:
```tsx
export const metadata: Metadata = {
  title: "Page Title",
  description: "Page description for SEO",
  openGraph: {
    title: "OG Title",
    description: "OG Description",
    images: ["/og-image.png"],
  },
};
```

## Build & Verify

After writing all files:
```
cd PROJECT_NAME && npm run build
```

If build fails, read the error, fix with edit_file, and rebuild. Common errors:
- Missing `'use client'` → add it to components using hooks or event handlers
- Import errors → check file paths and export names
- Type errors → fix TypeScript types
