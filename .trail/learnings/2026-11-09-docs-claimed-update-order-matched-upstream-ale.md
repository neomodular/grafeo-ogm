---
title: "Docs claimed update order matched upstream library, but it never did"
author: Ale
date: 2026-11-09
standing: true
id: l-6362f425
scope: repo
status: active
src: init-review
---

## Watch out
- Since v2.4.2 the docs said update operations ran in the same order as the upstream GraphQL library, but the order differed. Disconnect ran after the update body at the root, and update ran last instead of third.
- In the code: Upstream order is delete, disconnect, update, connect, create; ours (non-strict) is delete, disconnect, connect, create, update. Only strict mode uses upstream order. Verify parity claims against upstream source (create-update-and-params.js) before documenting them.

_From PR #28 here, Oct 22._
