import {existsSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {join} from "node:path/posix";
import type {Config} from "./config.js";
import {parseMarkdown} from "./markdown.js";
import type {RenderPage} from "./render.js";

export interface PageGenerator {
  generate(): Promise<RenderPage>;
  readonly path: string;
}

// TODO file shouldn’t have an .md on the end…
export function findPage(file: string, options: Config & {path: string}): PageGenerator {
  const {root, loaders} = options;
  const filepath = join(root, file);
  if (existsSync(filepath)) {
    return {
      generate: async () => parseMarkdown(await readFile(filepath, "utf-8"), options),
      path: filepath
    };
  }
  const loader = loaders.find(join("/", file));
  if (!loader) throw Object.assign(new Error("loader not found"), {code: "ENOENT"});
  return {
    generate: async () => parseMarkdown(await readFile(join(root, await loader.load()), "utf8"), options),
    path: loader.path
  };
}
