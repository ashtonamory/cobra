# Contributing

Thank you for helping. Before a large change, open an issue so we can agree
on the approach.

## Steps

1. Fork the repository and make a branch with a prefix: `feat/`, `fix/`,
   `chore/` or `docs/`.
2. Make the change, with tests. Each module has its test next to it
   (`foo.ts` and `foo.test.ts`).
3. Run `pnpm check`. It must pass.
4. Open a pull request against `main`. Say what changes for the person who
   uses Cobra, and how you tested it.

Pull requests are squash-merged.

## Rules

- Nothing listens on an address other than `127.0.0.1`.
- Anything that sends, spends, deletes or publishes goes through an approval.
- No secret goes into a model's context, a log or an error message.
- Text that the agents show to the person is short and plain. See
  [docs/voice.md](docs/voice.md).
- Do not add a cloud service, telemetry or a phone-home of any kind.

By contributing, you agree that your contribution is licensed under the MIT
license.
