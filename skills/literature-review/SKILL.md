---
name: literature-review
description: Find, verify, and synthesize scientific literature with traceable citations. Prefer configured literature MCP connectors; otherwise use the local literature CLI for PubMed, GenBank, arXiv, PubChem, and UniProt. Use for literature searches, evidence tables, paper comparisons, and review-ready summaries.
version: 0.2.4
license: Apache-2.0
category: research
requirements:
  - name: network
    kind: service
    description: Outbound HTTPS access to public literature APIs (api.crossref.org, export.arxiv.org, eutils.ncbi.nlm.nih.gov, rest.uniprot.org, pubchem.ncbi.nlm.nih.gov), or a configured literature MCP connector that performs retrieval.
  - name: pnpm
    kind: command
    optional: true
    description: Runs the literature CLI from a Pi-Science checkout with dependencies installed. Not needed when an authorized literature MCP connector handles retrieval.
risk: low
third_party:
  - kind: service
    name: Crossref REST API
    provider: Crossref
    license: provider-terms
    info_url: https://www.crossref.org/documentation/retrieve-metadata/rest-api/
    privacy_url: https://www.crossref.org/operations-and-sustainability/privacy/
  - kind: service
    name: arXiv API
    provider: arXiv (Cornell University)
    license: provider-terms
    info_url: https://info.arxiv.org/help/api/index.html
    terms_url: https://info.arxiv.org/help/api/tou.html
  - kind: service
    name: PubMed E-utilities
    provider: NCBI / U.S. National Library of Medicine
    license: provider-terms
    info_url: https://www.ncbi.nlm.nih.gov/books/NBK25501/
    privacy_url: https://www.nlm.nih.gov/web_policies.html
  - kind: service
    name: UniProtKB REST API
    provider: UniProt Consortium
    license: provider-terms
    info_url: https://www.uniprot.org/help/api
  - kind: service
    name: PubChem REST API
    provider: NCBI / U.S. National Library of Medicine
    license: provider-terms
    info_url: https://pubchem.ncbi.nlm.nih.gov/docs/rest
---

# Literature review

Ground every claim in retrieval results from a live provider. Never answer from memory, and never invent a DOI, PMID, arXiv id, accession, author-year citation, or search result that was not returned by a provider in this session.

## Retrieval strategy

1. Preferred path: if literature MCP tools are configured in this session (for example `literature.search` / `literature.fetch`, or another literature connector), use them first. Follow the connector's approval and data-egress policies.
2. Local fallback: otherwise run the local CLI below. It reuses `LiteratureService` for provider throttling, SSRF protection, and egress audit. No local HTTP gateway or provider credentials are required.
3. Failure handling: if a provider fails (non-2xx status, timeout, malformed payload), report that provider's failure explicitly and continue with the remaining providers. Never silently substitute memory for a failed or missing provider; if all providers fail, say so and stop.

## Local CLI

From a Pi-Science checkout with dependencies installed, pass a JSON object on stdin:

```sh
pnpm --silent literature:search <<'JSON'
{"query":"perovskite solar cells","providers":["pubmed","arxiv"]}
JSON
```

Use a JSON serializer for dynamic input; never interpolate query text into shell code. Omit `providers` to search all five providers, or select a non-empty subset:

| Provider | Coverage |
| --- | --- |
| `pubmed` | Biomedical literature via NCBI E-utilities |
| `genbank` | Nucleotide records via NCBI nuccore (GenBank) |
| `arxiv` | Preprints via arXiv |
| `pubchem` | Compound records via PubChem |
| `uniprot` | Protein records via UniProtKB |

For example, `{"query":"insulin","providers":["genbank","pubchem","uniprot"]}` retrieves the previously supported scientific records without enabling MCP connectors.

The CLI returns JSON with `results` and `failures`. Each result includes provider, query, hit count, records, retrieval time, and response hash. Queries are sent directly to the selected providers without sensitive-term screening or approval tokens, including sequences, compound identifiers, and custom terms. Only `query` and `providers` are accepted as input. If the CLI or dependencies are missing, use a configured MCP connector or report retrieval as unavailable.

Crossref is unsupported by this CLI. For Crossref/DOI-specific retrieval, use a configured authorized MCP connector; if unavailable, report the coverage gap explicitly. Do not silently substitute another provider.

Outbound requests use the existing provider egress audit and throttling. The CLI cache and throttle state last only for one invocation; run searches sequentially and respect provider limits across invocations.

## Result handling

- Normalize identifiers before comparing: lowercase DOIs and strip any `https://doi.org/` or `doi:` prefix; reduce arXiv ids to the canonical `NNNN.NNNNN` form (strip the `arXiv:` prefix, the `http://arxiv.org/abs/` prefix, and any `vN` version suffix, e.g. `http://arxiv.org/abs/2301.01234v2` becomes `2301.01234`).
- Deduplicate across providers: match by normalized DOI first, then by normalized title plus year.
- For every kept record, preserve: identifier(s), title, authors, year, venue, provider name, and retrieval timestamp (ISO 8601 UTC).

## Output format (mandatory)

The frontend auto-detects DOI strings in assistant messages and renders citations from this exact convention. Every response produced with this skill must follow it:

1. Inline citations: immediately after each claim, cite the bare identifier — `doi:10.xxxx/yyyy` for DOI-registered works, `arXiv:NNNN.NNNNN` for arXiv-only works. Keep sentence punctuation off the identifier: wrap the citation in parentheses, e.g. "... first demonstrated in dye-sensitized cells (doi:10.1021/ja809598r).", or leave a space before the punctuation.
2. References section: end the response with a `## References` heading followed by one numbered entry per cited source: authors (year), title, venue, a resolvable link (`https://doi.org/<doi>` or `https://arxiv.org/abs/<id>`), the provider the record came from, and the retrieval date. Example:

       ## References
       1. Kojima et al. (2009). Organometal halide perovskites as visible-light sensitizers for photovoltaic cells. Journal of the American Chemical Society. https://doi.org/10.1021/ja809598r — Crossref, retrieved 2026-07-26.

3. Unsourced claims: any claim without a retrieved source must be explicitly labeled as synthesis, e.g. "(synthesis, unverified)". Never attach an invented identifier to make a claim look sourced.

## Review artifacts

For each review also produce (condensed is fine): a search record (provider, exact query, date, hit count per search), an evidence table linking claims to identifiers and evidence strength, explicit inclusion/exclusion criteria, and a limitations section (coverage gaps, provider failures, screening depth). Distinguish retrieved facts from synthesis and unresolved questions.
