import {Fragment, jsx, jsxs} from "react/jsx-runtime";
import {renderToString} from "react-dom/server";

export default function App() {
  return jsxs(Fragment, {
    children: [
      jsx("h1", {
        children: "Hello, world!"
      }),
      "\n",
      jsx("p", {
        children: "Below is an example of markdown in JSX."
      }),
      "\n",
      jsx("div", {
        style: {
          backgroundColor: "violet",
          padding: "1rem"
        },
        children: jsxs("p", {
          children: [
            "Try and change the background color to ",
            jsx("code", {
              children: "tomato"
            }),
            "."
          ]
        })
      })
    ]
  });
}

console.log(renderToString(App()));
