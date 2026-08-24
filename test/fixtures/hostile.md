---
title: Hostile Input
---

# Attack Surface

<script>alert('xss')</script>

<img src="x" onerror="alert(1)" alt="broken image">

<a href="javascript:alert(1)">click me</a>

<iframe src="https://evil.example"></iframe>

<div id="123-bad-id" style="background: url(https://evil.example/track.png)">styled</div>

Unclosed tags: <b>bold <i>italic

Stray close: </div></p>

Entities: &nbsp; &copy; &mdash; &notarealentity; &amp;lt;

A CDATA-ish sequence: ]]> and a bare ampersand: R&D

<form action="https://evil.example"><input name="password" type="password" /></form>

## Fragment links

[to attack surface](#attack-surface) and [to nowhere](#does-not-exist)
