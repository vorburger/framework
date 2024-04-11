```js
import {createRoot} from "npm:react-dom/client";

const root = createRoot(display(document.createElement("DIV")));
```

```jsx
import App from "./hello-jsx.js";

root.render(<App />);
```
