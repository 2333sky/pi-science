import { createWebToolCore, getMaxInlineContentChars, markToolError } from "pi-web-access/web-tool-core.ts";
import { deleteResult, storeResult } from "pi-web-access/storage.ts";

/** The host owns schemas and permissions. The extraction-only answer hook returns
 * page text unchanged; it never calls a model. This also makes PDF text inline
 * and retrievable instead of returning the upstream temporary-file receipt. */
export function createNativeWebToolCore() {
  const ids = [];
  const remember = (id) => {
    ids.push(id);
    while (ids.length > 50) deleteResult(ids.shift());
  };
  const core = createWebToolCore({
    settings: {
      toolNames: { webSearch: "web_search", fetchContent: "web_fetch", getSearchContent: "web_fetch", sourceCheck: "source_check" },
      enabledTools: { webSearch: true, fetchContent: true, getSearchContent: true, sourceCheck: false },
      maxInlineContentChars: getMaxInlineContentChars(),
      fetchModes: { defaultMode: "readable", allowedModes: ["readable", "raw", "answer"] },
    },
    storeFetchedContent(id, data) { storeResult(id, data); remember(id); },
    publishResult(data) { remember(data.id); },
    async answerFromPage({ pageText }) { return { text: pageText }; },
    extractOptions: { rejectDirectImages: "Web fetch returns webpage and PDF text; direct images are unsupported." },
  });
  return {
    async webSearch(params, signal) { return markToolError(await core.webSearch(params, signal)); },
    async fetchContent(params, signal) {
      const request = params.mode === "raw" ? params : { ...params, mode: "answer", prompt: "Return extracted page text" };
      return markToolError(await core.fetchContent(request, signal));
    },
    async getSearchContent(params, signal) { return markToolError(await core.getSearchContent(params, signal)); },
  };
}
