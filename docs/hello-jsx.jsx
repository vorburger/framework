import {Card} from "./components/Card.js";

export default function App() {
  return (
    <>
      <h1>Hello, JSX!</h1>
      <p>JSX is a syntax extension for JavaScript.</p>
      <Card title="Untitled card">It was written to be used with React.</Card>
      <p>Below is an example of markdown in JSX.</p>
      <div style={{backgroundColor: "tomato", padding: "1rem"}}>
        <p>
          Try and change the background color to <code>tomato</code>.
        </p>
      </div>
    </>
  );
}
