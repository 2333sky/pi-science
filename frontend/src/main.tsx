import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "./index.css";
import "./i18n";
import { router } from "./app/router";
import { useUiStore } from "./lib/store";

const initialUi = useUiStore.getState();
document.documentElement.setAttribute("data-theme", initialUi.theme);
document.documentElement.lang = initialUi.locale;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
