# Korean Report Title Contract Design

## Goal

Change the Korean final-report heading from `# YYYY-MM-DD 어제 뭐 했지` to `# YYYY-MM-DD 뭐 했지` while preserving the existing English contract and every report body.

## Contract

- Korean report title: `# YYYY-MM-DD 뭐 했지`
- Korean sections and body: unchanged
- English report title: `# YYYY-MM-DD Yesterday's work`
- English sections and body: unchanged
- `daily`, raw events, filenames, jobs, and confirmation state: unchanged

## Code Changes

Update the Korean title in the shared report contract. Prompt generation, validation, self-test fixtures, scheduling fixtures, documentation, and pwiki examples must use the same title. Keep language selection behavior unchanged.

## Storage Migration

The registered storage currently contains 254 final reports. All 254 use the old Korean title and Korean section contract; no English report exists.

Replace only an exact first line matching `# YYYY-MM-DD 어제 뭐 했지`. Do not regenerate reports. Preserve every byte after the first line. Abort if any report has an unexpected title or if the migrated date does not match its filename.

## Verification

- Observe a focused test fail with the old implementation.
- Run the full Node test suite and self-test after the change.
- Validate all 254 migrated reports with the new Korean contract.
- Compare report bodies before and after migration.
- Confirm storage changes contain only report first-line replacements.
- Validate and reinstall the Codex plugin, then compare installed files with source.
- Commit and push code, storage, and pwiki before scheduling Windows shutdown.
