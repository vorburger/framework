#!/usr/bin/env node
import type {ParseArgsConfig} from "node:util";
import {parseArgs} from "node:util";
import * as clack from "@clack/prompts";
import {readConfig} from "../config.js";
import {CliError} from "../error.js";
import {faint, link, red} from "../tty.js";

const args = process.argv.slice(2);

const CONFIG_OPTION = {
  root: {
    type: "string"
  },
  config: {
    type: "string",
    short: "c"
  }
} as const;

// Convert --version or -v as first argument into version.
if (args[0] === "--version" || args[0] === "-v") args[0] = "version";

// Parse the initial options loosely.
const {values, positionals, tokens} = parseArgs({
  options: {
    help: {
      type: "boolean",
      short: "h"
    },
    debug: {
      type: "boolean",
      short: "d"
    }
  },
  strict: false,
  tokens: true,
  args
});

let command: string | undefined;

// Extract the command.
if (positionals.length > 0) {
  const t = tokens.find((t) => t.kind === "positional")!;
  args.splice(t.index, 1);
  command = positionals[0];

  // Convert help <command> into <command> --help.
  if (command === "help" && positionals.length > 1) {
    const p = tokens.find((p) => p.kind === "positional" && p !== t)!;
    args.splice(p.index - 1, 1, "--help");
    command = positionals[1];
  }
}

// Convert --help or -h (with no command) into help.
else if (values.help) {
  const t = tokens.find((t) => t.kind === "option" && t.name === "help")!;
  args.splice(t.index, 1);
  command = "help";
}

/** Commands that use Clack formatting. When handling CliErrors, clack.outro()
 * will be used for these commands. */
const CLACKIFIED_COMMANDS = ["create", "deploy", "login", "convert"];

try {
  switch (command) {
    case undefined:
    case "help": {
      helpArgs(command, {allowPositionals: true});
      console.log(
        `usage: observable <command>
  create       create a new project from a template
  preview      start the preview server
  build        generate a static site
  login        sign-in to Observable
  logout       sign-out of Observable
  deploy       deploy a project to Observable
  whoami       check authentication status
  convert      convert an Observable notebook to Markdown
  help         print usage information
  version      print the version`
      );
      if (command === undefined) process.exit(1);
      break;
    }
    case "version": {
      helpArgs(command, {});
      console.log(process.env.npm_package_version);
      break;
    }
    case "build": {
      const {
        values: {config, root}
      } = helpArgs(command, {
        options: {...CONFIG_OPTION}
      });
      await import("../build.js").then(async (build) => build.build({config: await readConfig(config, root)}));
      break;
    }
    case "create": {
      helpArgs(command, {});
      await import("../create.js").then(async (create) => create.create());
      break;
    }
    case "deploy": {
      const missingDescription = "one of 'build', 'cancel', or 'prompt' (the default)";
      const staleDescription = "one of 'build', 'cancel', 'deploy', or 'prompt' (the default)";
      const {
        values: {config, root, message, "if-stale": ifStale, "if-missing": ifMissing}
      } = helpArgs(command, {
        options: {
          ...CONFIG_OPTION,
          message: {
            type: "string",
            short: "m"
          },
          "if-stale": {
            type: "string",
            description: `What to do if the output directory is stale: ${staleDescription}`
          },
          "if-missing": {
            type: "string",
            description: `What to do if the output directory is missing: ${missingDescription}`
          }
        }
      });
      if (ifStale && ifStale !== "prompt" && ifStale !== "build" && ifStale !== "cancel" && ifStale !== "deploy") {
        console.log(`Invalid --if-stale option: ${ifStale}, expected ${staleDescription}`);
        process.exit(1);
      }
      if (ifMissing && ifMissing !== "prompt" && ifMissing !== "build" && ifMissing !== "cancel") {
        console.log(`Invalid --if-missing option: ${ifMissing}, expected ${missingDescription}`);
        process.exit(1);
      }
      if (!process.stdin.isTTY && (ifStale === "prompt" || ifMissing === "prompt")) {
        throw new CliError("Cannot prompt for input in non-interactive mode");
      }

      await import("../deploy.js").then(async (deploy) =>
        deploy.deploy({
          config: await readConfig(config, root),
          message,
          ifBuildMissing: (ifMissing ?? "prompt") as "prompt" | "build" | "cancel",
          ifBuildStale: (ifStale ?? "prompt") as "prompt" | "build" | "cancel" | "deploy"
        })
      );
      break;
    }
    case "preview": {
      const {values, tokens} = helpArgs(command, {
        tokens: true,
        options: {
          ...CONFIG_OPTION,
          host: {
            type: "string",
            default: "127.0.0.1"
          },
          port: {
            type: "string"
          },
          open: {
            type: "boolean",
            default: true
          },
          "no-open": {
            type: "boolean"
          }
        }
      });
      // https://nodejs.org/api/util.html#parseargs-tokens
      for (const token of tokens) {
        if (token.kind !== "option") continue;
        const {name} = token;
        if (name === "no-open") values.open = false;
        else if (name === "open") values.open = true;
      }
      const {config, root, host, port, open} = values;
      await import("../preview.js").then(async (preview) =>
        preview.preview({
          config,
          root,
          hostname: host!,
          port: port === undefined ? undefined : +port,
          open
        })
      );
      break;
    }
    case "login": {
      helpArgs(command, {});
      await import("../observableApiAuth.js").then((auth) => auth.login());
      break;
    }
    case "logout": {
      helpArgs(command, {});
      await import("../observableApiAuth.js").then((auth) => auth.logout());
      break;
    }
    case "whoami": {
      helpArgs(command, {});
      await import("../observableApiAuth.js").then((auth) => auth.whoami());
      break;
    }
    case "convert": {
      const {
        positionals,
        values: {output, force}
      } = helpArgs(command, {
        options: {output: {type: "string", default: "."}, force: {type: "boolean", short: "f"}},
        allowPositionals: true
      });
      await import("../convert.js").then((convert) => convert.convert(positionals, {output: output!, force}));
      break;
    }
    default: {
      console.error(`observable: unknown command '${command}'. See 'observable help'.`);
      process.exit(1);
      break;
    }
  }
} catch (error: any) {
  if (error instanceof CliError) {
    if (error.print) {
      if (command && CLACKIFIED_COMMANDS.includes(command)) {
        clack.outro(red(`Error: ${error.message}`));
      } else {
        console.error(red(error.message));
      }
    }
    process.exit(error.exitCode);
  } else {
    if (command && CLACKIFIED_COMMANDS.includes(command)) {
      clack.log.error(`${red("Error:")} ${error.message}`);
      if (values.debug) {
        clack.outro("The full error follows");
        throw error;
      } else {
        clack.log.info("To see the full stack trace, run with the --debug flag.");
        // clack.outro doesn't handle multiple lines well, so do it manually
        console.log(
          `${faint("│\n│")}  If you think this is a bug, please file an issue at\n${faint("└")}  ${link(
            "https://github.com/observablehq/framework/issues"
          )}\n`
        );
      }
    } else {
      console.error(`\n${red("Unexpected error:")} ${error.message}`);
      if (values.debug) {
        console.error("The full error follows\n");
        throw error;
      } else {
        console.error("\nTip: To see the full stack trace, run with the --debug flag.\n");
        console.error(
          `If you think this is a bug, please file an issue at\n↳ ${link(
            "https://github.com/observablehq/framework/issues"
          )}\n`
        );
      }
    }
  }
  process.exit(1);
}

type DescribableParseArgsConfig = ParseArgsConfig & {
  options?: {
    [longOption: string]: {
      type: "string" | "boolean";
      multiple?: boolean | undefined;
      short?: string | undefined;
      default?: string | boolean | string[] | boolean[] | undefined;
      description?: string;
    };
  };
};

// A wrapper for parseArgs that adds --help functionality with automatic usage.
// TODO It’d be nicer nice if we could change the return type to denote
// arguments with default values, and to enforce required arguments, if any.
function helpArgs<T extends DescribableParseArgsConfig>(
  command: string | undefined,
  config: T
): ReturnType<typeof parseArgs<T>> {
  let result: ReturnType<typeof parseArgs<T>>;
  try {
    result = parseArgs<T>({
      ...config,
      options: {...config.options, help: {type: "boolean", short: "h"}, debug: {type: "boolean"}},
      args
    });
  } catch (error: any) {
    if (!error.code?.startsWith("ERR_PARSE_ARGS_")) throw error;
    console.error(`observable: ${error.message}. See 'observable help${command ? ` ${command}` : ""}'.`);
    process.exit(1);
  }
  if ((result.values as any).help) {
    console.log(
      `Usage: observable ${command}${command === undefined || command === "help" ? " <command>" : ""}${Object.entries(
        config.options ?? {}
      )
        .map(([name, {default: def}]) => ` [--${name}${def === undefined ? "" : `=${def}`}]`)
        .join("")}`
    );
    if (Object.values(config.options ?? {}).some((spec) => spec.description)) {
      console.log();
      for (const [long, spec] of Object.entries(config.options ?? {})) {
        if (spec.description) {
          const left = `  ${spec.short ? `-${spec.short}, ` : ""}--${long}`.padEnd(20);
          console.log(`${left}${spec.description}`);
        }
      }
      console.log();
    }
    process.exit(0);
  }
  return result;
}
