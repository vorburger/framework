import {pathToFileURL} from "node:url";
import {renderToPipeableStream} from "react-dom/server";

const {default: render} = await import(pathToFileURL(process.argv[2]).href);

const {pipe} = renderToPipeableStream(render(), {
  onShellReady() {
    pipe(process.stdout);
  }
});
