# Dependency security patches

`braces@3.0.3.patch` mitigates
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
As of 2026-10-14, upstream has no fixed release. The parser accepts short but
deeply nested patterns that overflow its recursive compile/expand walkers.
The patch rejects AST nesting beyond 100 with a `SyntaxError`, consistent with
its existing input-length validation. Both parentheses and braces count toward
the bound; escaped, quoted, and bracket-literal characters do not.

This protects string-pattern entry points used by micromatch/fast-glob in
ESLint and shadcn. It does not validate caller-supplied AST objects. These are
build/developer tools, and the application does not import them for user input.

pnpm applies this patch through `package.json`'s `patchedDependencies`; the
Docker dependency stage must copy `patches/` before its frozen install. The
regression test resolves braces through the actual ESLint and shadcn dependency
chains, so it checks that both consumers receive the patched package.

Dependabot and `pnpm audit` still flag the unchanged upstream version. Do not
ignore the advisory globally. Replace this patch with the upstream fix when one
is available, and retain the regression coverage when upgrading.
