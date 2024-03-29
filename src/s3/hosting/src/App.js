import React from "react";
import { Light as SyntaxHighlighter } from "react-syntax-highlighter";
import json from "react-syntax-highlighter/dist/esm/languages/hljs/json";
import { solarizedDark } from "react-syntax-highlighter/dist/esm/styles/hljs";
import "./App.css";

SyntaxHighlighter.registerLanguage("json", json);

function App() {
  return (
    <div className="container">
      <SyntaxHighlighter language="json" style={solarizedDark}>
        {JSON.stringify({ version: process.env.REACT_APP_VERSION_FRONTEND }, null, 2)}
      </SyntaxHighlighter>
    </div>
  );
}

export default App;
