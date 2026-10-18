# Claude Code Review for Fork PRs

## Security Context

When a PR is submitted from a fork, GitHub Actions runs with restricted permissions for security reasons. This prevents malicious actors from accessing repository secrets or making unauthorized changes through automated workflows.

## How Claude Reviews Work on Fork PRs

### Automatic Review Options

1. **Via Comments**: Contributors can mention `@claude` in:
   - Issue comments on the PR
   - PR review comments
   - PR description (when using `pull_request_target`)

   These events run in the base repository context and have necessary permissions.

2. **Via pull_request_target**:
   - Triggered when PR is opened or synchronized if `@claude` is in the title or description
   - Runs with base repository permissions
   - Checks out the PR's actual code for review

### Manual Review Option

Maintainers can trigger Claude reviews manually using the "Claude Code - Fork PR Review" workflow:

1. Go to Actions → Claude Code - Fork PR Review
2. Click "Run workflow"
3. Enter the PR number
4. Optionally provide a custom prompt
5. Claude will review and comment on the PR

## Security Considerations

- **pull_request_target** runs with full permissions but checks out PR code safely
- The workflow only allows Claude to read code and post comments
- No arbitrary code execution from PR content
- Manual workflow requires maintainer approval

## For Contributors

To get Claude to review your fork PR:

1. Include `@claude` in your PR description with specific instructions
2. Or comment `@claude please review this PR` after opening
3. Or ask a maintainer to trigger the manual review workflow

## For Maintainers

- Monitor automated Claude reviews on fork PRs
- Use the manual workflow for sensitive or complex reviews
- Review Claude's comments before merging any fork PRs
- The workflow configuration prevents arbitrary code execution