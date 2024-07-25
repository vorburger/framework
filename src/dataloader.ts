import {createHash} from "node:crypto";
import type {WriteStream} from "node:fs";
import {createReadStream, existsSync, readdirSync, statSync} from "node:fs";
import {open, readFile, rename, unlink} from "node:fs/promises";
import {basename, dirname, extname, join, relative} from "node:path/posix";
import {createGunzip} from "node:zlib";
import {spawn} from "cross-spawn";
import JSZip from "jszip";
import {extract} from "tar-stream";
import {isEnoent} from "./error.js";
import {maybeStat, prepareOutput} from "./files.js";
import {FileWatchers} from "./fileWatchers.js";
import {formatByteSize} from "./format.js";
import {getFileInfo} from "./javascript/module.js";
import type {Logger, Writer} from "./logger.js";
import {cyan, faint, green, red, yellow} from "./tty.js";

const runningCommands = new Map<string, Promise<string>>();

export const defaultInterpreters: Record<string, string[]> = {
  ".js": ["node", "--no-warnings=ExperimentalWarning"],
  ".ts": ["tsx"],
  ".py": ["python3"],
  ".r": ["Rscript"],
  ".R": ["Rscript"],
  ".rs": ["rust-script"],
  ".go": ["go", "run"],
  ".java": ["java"],
  ".jl": ["julia"],
  ".php": ["php"],
  ".sh": ["sh"],
  ".exe": []
};

export interface LoadEffects {
  logger: Logger;
  output: Writer;
}

const defaultEffects: LoadEffects = {
  logger: console,
  output: process.stdout
};

export interface LoaderOptions {
  root: string;
  path: string;
  targetPath: string;
  useStale: boolean;
}

export class LoaderResolver {
  private readonly root: string;
  private readonly interpreters: Map<string, string[]>;

  constructor({root, interpreters}: {root: string; interpreters?: Record<string, string[] | null>}) {
    this.root = root;
    this.interpreters = new Map(
      Object.entries({...defaultInterpreters, ...interpreters}).filter(
        (entry): entry is [string, string[]] => entry[1] != null
      )
    );
  }

  /**
   * Finds the loader for the specified target path, relative to the specified
   * source root, if it exists. If there is no such loader, returns undefined.
   * For files within archives, we find the first parent folder that exists, but
   * abort if we find a matching folder or reach the source root; for example,
   * if src/data exists, we won’t look for a src/data.zip.
   */
  find(targetPath: string, {useStale = false} = {}): Loader | undefined {
    const exact = this.findExact(targetPath, {useStale});
    if (exact) return exact;
    let dir = dirname(targetPath);
    for (let parent: string; true; dir = parent) {
      parent = dirname(dir);
      if (parent === dir) return; // reached source root
      if (existsSync(join(this.root, dir))) return; // found folder
      if (existsSync(join(this.root, parent))) break; // found parent
    }
    for (const [ext, Extractor] of extractors) {
      const archive = dir + ext;
      if (existsSync(join(this.root, archive))) {
        return new Extractor({
          preload: async () => archive,
          inflatePath: targetPath.slice(archive.length - ext.length + 1),
          path: join(this.root, archive),
          root: this.root,
          targetPath,
          useStale
        });
      }
      const archiveLoader = this.findExact(archive, {useStale});
      if (archiveLoader) {
        return new Extractor({
          preload: async (options) => archiveLoader.load(options),
          inflatePath: targetPath.slice(archive.length - ext.length + 1),
          path: archiveLoader.path,
          root: this.root,
          targetPath,
          useStale
        });
      }
    }
  }

  private findExact(targetPath: string, {useStale}): Loader | undefined {
    for (const [ext, [command, ...args]] of this.interpreters) {
      if (!existsSync(join(this.root, targetPath + ext))) continue;
      if (extname(targetPath) === "") {
        console.warn(`invalid data loader path: ${targetPath + ext}`);
        return;
      }
      const path = join(this.root, targetPath + ext);
      return new CommandLoader({
        command: command ?? path,
        args: command == null ? args : [...args, path],
        path,
        root: this.root,
        targetPath,
        useStale
      });
    }
    // check for parameterized path
    let dir = targetPath;
    for (let parent: string; true; dir = parent) {
      parent = dirname(dir);
      try {
        for (const file of readdirSync(join(this.root, parent))) {
          const match = /^\[(\w+)\](\.\w+)*$/.exec(file);
          if (!match) continue;
          const interpreter = this.interpreters.get(match[2]);
          if (!interpreter) continue;
          const [command, ...args] = interpreter;
          const path = join(this.root, parent, file);
          if (command != null) args.push(path);
          // TODO extract parameter
          // TODO decodeURI? probably should have happened earlier
          args.push(`--${match[1]}`, basename(targetPath));
          return new CommandLoader({
            command: command ?? path,
            args,
            path,
            root: this.root,
            targetPath,
            useStale
          });
        }
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      return; // TODO
      // if (parent === dir) return; // reached source root
      // if (existsSync(join(this.root, dir))) return; // found folder
      // if (existsSync(join(this.root, parent))) break; // found parent
    }
  }

  getWatchPath(path: string): string | undefined {
    const exactPath = join(this.root, path);
    if (existsSync(exactPath)) return exactPath;
    if (exactPath.endsWith(".js")) {
      const jsxPath = exactPath + "x";
      if (existsSync(jsxPath)) return jsxPath;
    }
    return this.find(path)?.path;
  }

  watchFiles(path: string, watchPaths: Iterable<string>, callback: (name: string) => void) {
    return FileWatchers.of(this, path, watchPaths, callback);
  }

  /**
   * Returns the path to the backing file during preview, which is the source
   * file for the associated data loader if the file is generated by a loader.
   */
  private getSourceFilePath(name: string): string {
    let path = name;
    if (!existsSync(join(this.root, path))) {
      const loader = this.find(path);
      if (loader) path = relative(this.root, loader.path);
    }
    return path;
  }

  /**
   * Returns the path to the backing file during build, which is the cached
   * output file if the file is generated by a loader.
   */
  private getOutputFilePath(name: string): string {
    let path = name;
    if (!existsSync(join(this.root, path))) {
      const loader = this.find(path);
      if (loader) path = join(".observablehq", "cache", name);
    }
    return path;
  }

  /**
   * Returns the hash of the file with the given name within the source root, or
   * if the name refers to a file generated by a data loader, the hash of the
   * corresponding data loader source and its modification time. The latter
   * ensures that if the data loader is “touched” (even without changing its
   * contents) that the data loader will be re-run.
   */
  getSourceFileHash(name: string): string {
    const path = this.getSourceFilePath(name);
    const info = getFileInfo(this.root, path);
    if (!info) return createHash("sha256").digest("hex");
    const {hash} = info;
    return path === name ? hash : createHash("sha256").update(hash).update(String(info.mtimeMs)).digest("hex");
  }

  getSourceLastModified(name: string): number | undefined {
    const entry = getFileInfo(this.root, this.getSourceFilePath(name));
    return entry && Math.floor(entry.mtimeMs);
  }

  getOutputLastModified(name: string): number | undefined {
    const entry = getFileInfo(this.root, this.getOutputFilePath(name));
    return entry && Math.floor(entry.mtimeMs);
  }

  resolveFilePath(path: string): string {
    return `/${join("_file", path)}?sha=${this.getSourceFileHash(path)}`;
  }
}

export abstract class Loader {
  /**
   * The source root relative to the current working directory, such as src.
   */
  readonly root: string;

  /**
   * The path to the loader script or executable relative to the current working
   * directory. This is exposed so that clients can check which file to watch to
   * see if the loader is edited (and in which case it needs to be re-run).
   */
  readonly path: string;

  /**
   * The path to the loader script’s output relative to the destination root.
   * This is where the loader’s output is served, but the loader generates the
   * file in the .observablehq/cache directory within the source root.
   */
  readonly targetPath: string;

  /**
   * Should the loader use a stale cache. true when building.
   */
  readonly useStale?: boolean;

  constructor({root, path, targetPath, useStale}: LoaderOptions) {
    this.root = root;
    this.path = path;
    this.targetPath = targetPath;
    this.useStale = useStale;
  }

  /**
   * Runs this loader, returning the path to the generated output file relative
   * to the source root; this is within the .observablehq/cache folder within
   * the source root.
   */
  async load(effects = defaultEffects): Promise<string> {
    const key = join(this.root, this.targetPath);
    let command = runningCommands.get(key);
    if (!command) {
      command = (async () => {
        const outputPath = join(".observablehq", "cache", this.targetPath);
        const cachePath = join(this.root, outputPath);
        const loaderStat = await maybeStat(this.path);
        const cacheStat = await maybeStat(cachePath);
        if (!cacheStat) effects.output.write(faint("[missing] "));
        else if (cacheStat.mtimeMs < loaderStat!.mtimeMs) {
          if (this.useStale) return effects.output.write(faint("[using stale] ")), outputPath;
          else effects.output.write(faint("[stale] "));
        } else return effects.output.write(faint("[fresh] ")), outputPath;
        const tempPath = join(this.root, ".observablehq", "cache", `${this.targetPath}.${process.pid}`);
        const errorPath = tempPath + ".err";
        const errorStat = await maybeStat(errorPath);
        if (errorStat) {
          if (errorStat.mtimeMs > loaderStat!.mtimeMs && errorStat.mtimeMs > -1000 + Date.now())
            throw new Error("loader skipped due to recent error");
          else await unlink(errorPath).catch(() => {});
        }
        await prepareOutput(tempPath);
        await prepareOutput(cachePath);
        const tempFd = await open(tempPath, "w");
        try {
          await this.exec(tempFd.createWriteStream({highWaterMark: 1024 * 1024}), effects);
          await rename(tempPath, cachePath);
        } catch (error) {
          await rename(tempPath, errorPath);
          throw error;
        } finally {
          await tempFd.close();
        }
        return outputPath;
      })();
      command.finally(() => runningCommands.delete(key)).catch(() => {});
      runningCommands.set(key, command);
    }
    effects.output.write(`${cyan("load")} ${this.path} ${faint("→")} `);
    const start = performance.now();
    command.then(
      (path) => {
        const {size} = statSync(join(this.root, path));
        effects.logger.log(
          `${green("success")} ${size ? cyan(formatByteSize(size)) : yellow("empty output")} ${faint(
            `in ${formatElapsed(start)}`
          )}`
        );
      },
      (error) => {
        effects.logger.log(`${red("error")} ${faint(`in ${formatElapsed(start)}:`)} ${red(error.message)}`);
      }
    );
    return command;
  }

  abstract exec(output: WriteStream, effects?: LoadEffects): Promise<void>;
}

interface CommandLoaderOptions extends LoaderOptions {
  command: string;
  args: string[];
}

class CommandLoader extends Loader {
  /**
   * The command to run, such as "node" for a JavaScript loader, "tsx" for
   * TypeScript, and "sh" for a shell script. "noop" when we only need to
   * inflate a file from a static archive.
   */
  private readonly command: string;

  /**
   * Args to pass to the command; currently this is a single argument of the
   * path to the loader script relative to the current working directory. (TODO
   * Support passing additional arguments to loaders.)
   */
  private readonly args: string[];

  constructor({command, args, ...options}: CommandLoaderOptions) {
    super(options);
    this.command = command;
    this.args = args;
  }

  async exec(output: WriteStream): Promise<void> {
    const subprocess = spawn(this.command, this.args, {windowsHide: true, stdio: ["ignore", output, "inherit"]});
    const code = await new Promise((resolve, reject) => {
      subprocess.on("error", reject);
      subprocess.on("close", resolve);
    });
    if (code !== 0) {
      throw new Error(`loader exited with code ${code}`);
    }
  }
}

interface ZipExtractorOptions extends LoaderOptions {
  preload: Loader["load"];
  inflatePath: string;
}

class ZipExtractor extends Loader {
  private readonly preload: Loader["load"];
  private readonly inflatePath: string;

  constructor({preload, inflatePath, ...options}: ZipExtractorOptions) {
    super(options);
    this.preload = preload;
    this.inflatePath = inflatePath;
  }

  async exec(output: WriteStream, effects?: LoadEffects): Promise<void> {
    const archivePath = join(this.root, await this.preload(effects));
    const file = (await JSZip.loadAsync(await readFile(archivePath))).file(this.inflatePath);
    if (!file) throw Object.assign(new Error("file not found"), {code: "ENOENT"});
    const pipe = file.nodeStream().pipe(output);
    await new Promise((resolve, reject) => pipe.on("error", reject).on("finish", resolve));
  }
}

interface TarExtractorOptions extends LoaderOptions {
  preload: Loader["load"];
  inflatePath: string;
  gunzip?: boolean;
}

class TarExtractor extends Loader {
  private readonly preload: Loader["load"];
  private readonly inflatePath: string;
  private readonly gunzip: boolean;

  constructor({preload, inflatePath, gunzip = false, ...options}: TarExtractorOptions) {
    super(options);
    this.preload = preload;
    this.inflatePath = inflatePath;
    this.gunzip = gunzip;
  }

  async exec(output: WriteStream, effects?: LoadEffects): Promise<void> {
    const archivePath = join(this.root, await this.preload(effects));
    const tar = extract();
    const input = createReadStream(archivePath);
    (this.gunzip ? input.pipe(createGunzip()) : input).pipe(tar);
    for await (const entry of tar) {
      if (entry.header.name === this.inflatePath) {
        const pipe = entry.pipe(output);
        await new Promise((resolve, reject) => pipe.on("error", reject).on("finish", resolve));
        return;
      } else {
        entry.resume();
      }
    }
    throw Object.assign(new Error("file not found"), {code: "ENOENT"});
  }
}

class TarGzExtractor extends TarExtractor {
  constructor(options: TarExtractorOptions) {
    super({...options, gunzip: true});
  }
}

const extractors = [
  [".zip", ZipExtractor],
  [".tar", TarExtractor],
  [".tar.gz", TarGzExtractor],
  [".tgz", TarGzExtractor]
] as const;

function formatElapsed(start: number): string {
  const elapsed = performance.now() - start;
  return `${Math.floor(elapsed)}ms`;
}
