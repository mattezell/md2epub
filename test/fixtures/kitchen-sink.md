---
title: Kitchen Sink
author: [Ada Lovelace, Alan Turing]
language: en
publisher: Test Press
subjects: [testing, markdown]
rights: Public domain
date: "2026-08-24"
description: Every Markdown feature the converter claims to handle.
---

# Structure

Paragraph with **bold**, *italic*, ***both***, `code`, ~~strike~~, and a
line break at the end of this line.\
Second line after a hard break.

## Lists

- unordered
  - nested
    - deeper
- back to top level

1. ordered
2. second
   1. nested ordered

- [ ] task not done
- [x] task done

## Quotes and rules

> A quote.
>
> > Nested deeper.

***

## Code

```python
def hello(name: str) -> str:
    return f"hello {name} <tag> & more"
```

    indented code block
    second line

## Tables

| Left | Center | Right |
|:-----|:------:|------:|
| a    | b      | c     |
| long cell content | x | 42 |

## Links

[External](https://example.com/path?a=1&b=2), [anchor](#code), <https://autolink.example.com>,
[mailto](mailto:someone@example.com).

## Definition-ish

Term
: not supported by default, renders as a paragraph

# Second Part

### A deep heading with no parent

Text under it.

#### Deeper still

More text.
