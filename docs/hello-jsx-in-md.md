```js
import {createElement} from "npm:react";
import {createRoot} from "npm:react-dom/client";

const root = createRoot(display(document.createElement("DIV")));
```

```js
import App from "./hello-jsx.js";

root.render(createElement(App));
```
