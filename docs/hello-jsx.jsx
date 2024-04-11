import React from "react";

export default function App() {
  return (
    <>
      <h1>Hello, JSX!</h1>
      <p>JSX is a syntax extension for JavaScript.</p>
      <p>It was written to be used with React.</p>
      <p>Below is an example of markdown in JSX.</p>
      <div style={{backgroundColor: "tomato", padding: "1rem"}}>
        <p>
          Try and change the background color to <code>tomato</code>.
        </p>
      </div>
    </>
  );
}
