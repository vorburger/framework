import {existsSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {join} from "node:path/posix";
import type {Config} from "./config.js";
import type {JavaScriptNode} from "./javascript/parse.js";
import {parseMarkdown} from "./markdown.js";

export interface PageSource {
  title: string | null;
  head: string | null;
  header: string | null;
  body: string;
  footer: string | null;
  data: PageConfig;
  style: string | null;
  code: PageCode[];
}

export interface PageConfig {
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

export interface PageCode {
  id: string;
  node: JavaScriptNode;
}

export interface PageGenerator {
  /** The path to watch if this page changes. */
  readonly path: string;
  /** Generate the page. */
  generate(): Promise<PageSource>;
}

export function findPage(path: string, config: Config): PageGenerator {
  const {root, loaders} = config;
  const file = path.replace(/\.html$/i, "") + ".md";
  const filepath = join(root, file);
  if (existsSync(filepath)) {
    return {
      path: filepath,
      async generate() {
        const source = await readFile(filepath, "utf-8");
        return parseMarkdown(source, {...config, path});
      }
    };
  }
  const loader = loaders.find(join("/", file));
  if (!loader) throw Object.assign(new Error("loader not found"), {code: "ENOENT"});
  return {
    path: loader.path,
    async generate() {
      const cachepath = join(root, await loader.load());
      const source = await readFile(cachepath, "utf-8");
      return parseMarkdown(source, {...config, path});
    }
  };
}
