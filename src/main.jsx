import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import storagePolyfill from "./storageClient.js";

// Make the app's existing window.storage.get/set/delete/list calls work
// on a real website (see storageClient.js for details).
window.storage = storagePolyfill;

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
