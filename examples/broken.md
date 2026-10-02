# Deliberately broken markdown

This file exists to be wrong. `mdcheck examples/` is expected to report
problems here, and CI asserts that it does (exit 1, non-empty JSON). Do not fix
anything on this page -- it is test data.

## A broken file link

[does not exist](does-not-exist.md)

## A broken anchor

The target [guide](../docs/codes.md#no-such-heading) has no such heading.

## An empty target

[points nowhere]()

## An absolute path

[/etc/passwd](/etc/passwd)

## Links that are fine

[the real guide](../docs/codes.md)
[configuration](../docs/configuration.md)
<https://example.com/should-be-skipped>

## Links hidden in code

These must not be reported:

```markdown
[fenced link](does-not-exist.md)
```

`[inline code link](does-not-exist.md)`

~~~
[tilde fenced](does-not-exist.md)
~~~

## A reference that resolves

See [the guide][guide] and [config][config].

[guide]: ../docs/codes.md "The diagnostic codes"
[config]: ../docs/configuration.md

## A reference that does not

[text][missing-definition]
