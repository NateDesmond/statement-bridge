# Security policy

Statement Bridge runs entirely on-device: no network requests, no host
permissions, `connect-src 'none'` in the extension's Content Security
Policy. Still, if you find a security issue, please report it privately
rather than opening a public issue.

## Reporting a vulnerability

Report privately through the [Urban Algorithm contact
page](https://urbanalgorithm.com), or via the "Support" link on
[statementbridge.urbanalgorithm.com](https://statementbridge.urbanalgorithm.com/support.html).
Please include:

- A description of the issue and its impact.
- Steps to reproduce, if possible.
- The extension version (`extension/manifest.json`'s `version`) and
  browser version.

We'll acknowledge your report and follow up with next steps. Please give
us a reasonable amount of time to address the issue before any public
disclosure.

## Scope

In scope: the Chrome extension (`extension/`) and the marketing site
(`site/`). Design mockups (`designs/`) are static prototypes, not shipped
code, and are out of scope.
