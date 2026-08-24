---
title: Diagram Fixture
author: Test Author
---

# Diagrams

A flowchart with a title:

```mermaid
---
title: Conversion path
---
graph LR
    M[Markdown] --> C[Converter]
    C --> E[EPUB]
```

A sequence diagram:

```mermaid
sequenceDiagram
    participant A as Author
    participant K as Kindle
    A->>K: send epub
    K-->>A: it arrives
```

An ordinary fence, which must stay a code block:

```bash
md2epub notes.md --diagrams --kindle
```

A deliberately broken diagram, which must degrade rather than fail:

```mermaid
graph TD
    this is not ((valid mermaid {{{
```
