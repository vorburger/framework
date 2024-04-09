import mime from "mime";
import type {Config, Page, Script, Section} from "./config.js";
import {mergeStyle, mergeToc} from "./config.js";
import {getClientPath} from "./files.js";
import type {Html, HtmlResolvers} from "./html.js";
import {html, parseHtml, rewriteHtml, rewriteHtmlPaths} from "./html.js";
import type {JavaScriptNode} from "./javascript/parse.js";
import {transpileJavaScript} from "./javascript/transpile.js";
import type {PageLink} from "./pager.js";
import {findLink, normalizePath} from "./pager.js";
import {isAssetPath, relativePath, resolvePath, resolveRelativePath} from "./path.js";
import type {Resolvers} from "./resolvers.js";
import {getResolvers} from "./resolvers.js";
import {rollupClient} from "./rollup.js";
import {InvalidThemeError} from "./theme.js";
import {red} from "./tty.js";

export interface RenderOptions extends Config {
  root: string;
  path: string;
  resolvers?: Resolvers;
}

export interface RenderPage {
  title: string | null;
  head: string | null;
  header: string | null;
  body: string;
  footer: string | null;
  data: RenderPageConfig;
  style: string | null;
  code: RenderCode[];
}

export interface RenderPageConfig {
  title?: string | null;
  toc?: {show?: boolean; label?: string};
  style?: string | null;
  theme?: string[];
  head?: string | null;
  header?: string | null;
  footer?: string | null;
  index?: boolean;
  keywords?: string[];
  draft?: boolean;
  sidebar?: boolean;
  sql?: {[key: string]: string};
}

export interface RenderCode {
  id: string;
  node: JavaScriptNode;
}

type RenderInternalOptions =
  | {preview?: false} // build
  | {preview: true}; // preview

export async function renderPage(page: RenderPage, options: RenderOptions & RenderInternalOptions): Promise<string> {
  const {data} = page;
  const {base, path, title, preview} = options;
  const {loaders, resolvers = await getResolvers(page, options)} = options;
  const {draft = false, sidebar = options.sidebar} = data;
  const toc = mergeToc(data.toc, options.toc);
  const {files, resolveFile, resolveImport} = resolvers;
  return String(html`<!DOCTYPE html>
<meta charset="utf-8">${path === "/404" ? html`\n<base href="${preview ? "/" : base}">` : ""}
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
${
  page.title || title
    ? html`<title>${[page.title, page.title === title ? null : title]
        .filter((title): title is string => !!title)
        .join(" | ")}</title>\n`
    : ""
}${renderHead(page.head, resolvers, options)}${
    path === "/404"
      ? html.unsafe(`\n<script type="module">

if (location.pathname.endsWith("/")) {
  const alt = location.pathname.slice(0, -1);
  fetch(alt, {method: "HEAD"}).then((response) => response.ok && location.replace(alt + location.search + location.hash));
}

</script>`)
      : ""
  }
<script type="module">${html.unsafe(`

import ${preview || page.code.length ? `{${preview ? "open, " : ""}define} from ` : ""}${JSON.stringify(
    resolveImport("observablehq:client")
  )};${
    files.size || data?.sql
      ? `\nimport {registerFile${data?.sql ? ", FileAttachment" : ""}} from ${JSON.stringify(
          resolveImport("observablehq:stdlib")
        )};`
      : ""
  }${data?.sql ? `\nimport {registerTable} from ${JSON.stringify(resolveImport("npm:@observablehq/duckdb"))};` : ""}${
    files.size
      ? `\n${registerFiles(
          files,
          resolveFile,
          preview
            ? (name) => loaders.getSourceLastModified(resolvePath(path, name))
            : (name) => loaders.getOutputLastModified(resolvePath(path, name))
        )}`
      : ""
  }${data?.sql ? `\n${registerTables(data.sql, options)}` : ""}
${preview ? `\nopen({hash: ${JSON.stringify(resolvers.hash)}, eval: (body) => eval(body)});\n` : ""}${page.code
    .map(({node, id}) => `\n${transpileJavaScript(node, {id, path, resolveImport})}`)
    .join("")}`)}
</script>${sidebar ? html`\n${await renderSidebar(options)}` : ""}${
    toc.show ? html`\n${renderToc(findHeaders(page), toc.label)}` : ""
  }
<div id="observablehq-center">${renderHeader(page.header, resolvers)}
<main id="observablehq-main" class="observablehq${draft ? " observablehq--draft" : ""}">
${html.unsafe(rewriteHtml(page.body, resolvers))}</main>${renderFooter(page.footer, resolvers, options)}
</div>
`);
}

function registerTables(sql: Record<string, string>, options: RenderOptions): string {
  return Object.entries(sql)
    .map(([name, source]) => registerTable(name, source, options))
    .join("\n");
}

function registerTable(name: string, source: string, {path}: RenderOptions): string {
  return `registerTable(${JSON.stringify(name)}, ${
    isAssetPath(source)
      ? `FileAttachment(${JSON.stringify(resolveRelativePath(path, source))})`
      : JSON.stringify(source)
  });`;
}

function registerFiles(
  files: Iterable<string>,
  resolve: (name: string) => string,
  getLastModified: (name: string) => number | undefined
): string {
  return Array.from(files)
    .sort()
    .map((f) => registerFile(f, resolve, getLastModified))
    .join("");
}

function registerFile(
  name: string,
  resolve: (name: string) => string,
  getLastModified: (name: string) => number | undefined
): string {
  return `\nregisterFile(${JSON.stringify(name)}, ${JSON.stringify({
    name,
    mimeType: mime.getType(name) ?? undefined,
    path: resolve(name),
    lastModified: getLastModified(name)
  })});`;
}

async function renderSidebar(options: RenderOptions): Promise<Html> {
  const {title = "Home", pages, root, path, search, md} = options;
  const {normalizeLink} = md;
  return html`<input id="observablehq-sidebar-toggle" type="checkbox" title="Toggle sidebar">
<label id="observablehq-sidebar-backdrop" for="observablehq-sidebar-toggle"></label>
<nav id="observablehq-sidebar">
  <ol>
    <label id="observablehq-sidebar-close" for="observablehq-sidebar-toggle"></label>
    <li class="observablehq-link${
      normalizePath(path) === "/index" ? " observablehq-link-active" : ""
    }"><a href="${md.normalizeLink(relativePath(path, "/"))}">${title}</a></li>
  </ol>${
    search
      ? html`\n  <div id="observablehq-search"><input type="search" placeholder="Search"></div>
  <div id="observablehq-search-results"></div>
  <script>{${html.unsafe(
    (await rollupClient(getClientPath("search-init.js"), root, path, {minify: true})).trim()
  )}}</script>`
      : ""
  }
  <ol>${pages.map((p, i) =>
    "pages" in p
      ? html`${i > 0 && "path" in pages[i - 1] ? html`</ol>` : ""}
    <${p.collapsible ? (p.open || isSectionActive(p, path) ? "details open" : "details") : "section"}${
      isSectionActive(p, path) ? html` class="observablehq-section-active"` : ""
    }>
      <summary>${p.name}</summary>
      <ol>${p.pages.map((p) => renderListItem(p, path, normalizeLink))}
      </ol>
    </${p.collapsible ? "details" : "section"}>`
      : "path" in p
      ? html`${i > 0 && "pages" in pages[i - 1] ? html`\n  </ol>\n  <ol>` : ""}${renderListItem(
          p,
          path,
          normalizeLink
        )}`
      : ""
  )}
  </ol>
</nav>
<script>{${html.unsafe(
    (await rollupClient(getClientPath("sidebar-init.js"), root, path, {minify: true})).trim()
  )}}</script>`;
}

function isSectionActive(s: Section<Page>, path: string): boolean {
  return s.pages.some((p) => normalizePath(p.path) === path);
}

interface Header {
  label: string;
  href: string;
}

const tocSelector = "h1:not(:first-of-type), h2:first-child, :not(h1) + h2";

function findHeaders(page: RenderPage): Header[] {
  return Array.from(parseHtml(page.body).document.querySelectorAll(tocSelector))
    .map((node) => ({label: node.textContent, href: node.firstElementChild?.getAttribute("href")}))
    .filter((d): d is Header => !!d.label && !!d.href);
}

function renderToc(headers: Header[], label: string): Html {
  return html`<aside id="observablehq-toc" data-selector="${tocSelector}">
<nav>${
    headers.length > 0
      ? html`
<div>${label}</div>
<ol>${headers.map(
          ({label, href}) => html`\n<li class="observablehq-secondary-link"><a href="${href}">${label}</a></li>`
        )}
</ol>`
      : ""
  }
</nav>
</aside>`;
}

function renderListItem(page: Page, path: string, normalizeLink: (href: string) => string): Html {
  return html`\n    <li class="observablehq-link${
    normalizePath(page.path) === path ? " observablehq-link-active" : ""
  }"><a href="${normalizeLink(relativePath(path, page.path))}">${page.name}</a></li>`;
}

function renderHead(head: RenderPage["head"], resolvers: Resolvers, {scripts, root}: RenderOptions): Html {
  const {stylesheets, staticImports, resolveImport, resolveStylesheet} = resolvers;
  const resolveScript = (src: string) => (/^\w+:/.test(src) ? src : resolveImport(relativePath(root, src)));
  return html`<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>${
    Array.from(new Set(Array.from(stylesheets, (i) => resolveStylesheet(i))), renderStylesheetPreload) // <link rel=preload as=style>
  }${
    Array.from(new Set(Array.from(stylesheets, (i) => resolveStylesheet(i))), renderStylesheet) // <link rel=stylesheet>
  }${
    Array.from(new Set(Array.from(staticImports, (i) => resolveImport(i))), renderModulePreload) // <link rel=modulepreload>
  }${
    head ? html`\n${html.unsafe(rewriteHtml(head, resolvers))}` : null // arbitrary user content
  }${
    Array.from(scripts, (s) => renderScript(s, resolveScript)) // <script src>
  }`;
}

function renderScript(script: Script, resolve: (specifier: string) => string): Html {
  return html`\n<script${script.type ? html` type="${script.type}"` : null}${
    script.async ? html` async` : null
  } src="${resolve(script.src)}"></script>`;
}

function renderStylesheet(href: string): Html {
  return html`\n<link rel="stylesheet" type="text/css" href="${href}"${/^\w+:/.test(href) ? " crossorigin" : ""}>`;
}

function renderStylesheetPreload(href: string): Html {
  return html`\n<link rel="preload" as="style" href="${href}"${/^\w+:/.test(href) ? " crossorigin" : ""}>`;
}

function renderModulePreload(href: string): Html {
  return html`\n<link rel="modulepreload" href="${href}">`;
}

function renderHeader(header: RenderPage["header"], resolvers: HtmlResolvers): Html | null {
  return header
    ? html`\n<header id="observablehq-header">\n${html.unsafe(rewriteHtml(header, resolvers))}\n</header>`
    : null;
}

function renderFooter(footer: RenderPage["footer"], resolvers: HtmlResolvers, options: RenderOptions): Html | null {
  const {path, md} = options;
  const link = options.pager ? findLink(path, options) : null;
  return link || footer
    ? html`\n<footer id="observablehq-footer">${link ? renderPager(path, link, md.normalizeLink) : ""}${
        footer ? html`\n<div>${html.unsafe(rewriteHtml(footer, resolvers))}</div>` : ""
      }
</footer>`
    : null;
}

function renderPager(path: string, {prev, next}: PageLink, normalizeLink: (href: string) => string): Html {
  return html`\n<nav>${prev ? renderRel(path, prev, "prev", normalizeLink) : ""}${
    next ? renderRel(path, next, "next", normalizeLink) : ""
  }</nav>`;
}

function renderRel(path: string, page: Page, rel: "prev" | "next", normalizeLink: (href: string) => string): Html {
  return html`<a rel="${rel}" href="${normalizeLink(relativePath(path, page.path))}"><span>${page.name}</span></a>`;
}

export function resolveStyle(
  data: RenderPageConfig,
  {path, style = null}: {path: string; style?: Config["style"]}
): string | null {
  try {
    style = mergeStyle(path, data.style, data.theme, style);
  } catch (error) {
    if (!(error instanceof InvalidThemeError)) throw error;
    console.error(red(String(error))); // TODO error during build
    style = {theme: []};
  }
  return !style
    ? null
    : "path" in style
    ? relativePath(path, style.path)
    : `observablehq:theme-${style.theme.join(",")}.css`;
}

export function resolveHtml(
  key: "head" | "header" | "footer",
  data: RenderPageConfig,
  {path, [key]: defaultValue}: Partial<Pick<Config, typeof key>> & {path: string}
): string | null {
  return data[key] !== undefined
    ? data[key]
      ? String(data[key])
      : null
    : defaultValue != null
    ? rewriteHtmlPaths(defaultValue, path)
    : null;
}
