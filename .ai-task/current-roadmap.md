# Yamzo order retention and operator UX release

## Scope

- Disable deletion of every order type across the Website admin/API/database and Yamzo POS.
- Preserve cancellation as the terminal operator action.
- Do not change deletion flows for restocks, inventory, costs, or other non-order records.
- Make cancellation reasoned and auditable in the Website admin workspace.
- Rebuild the affected admin, authentication, and account surfaces from the local shadcn/Radix component layer, with loading and responsive states.
- Keep each admin destination as a dedicated route and make the storefront filter/search panel become sticky only after it reaches the header while scrolling.
- Publish verified source changes to the existing GitHub repositories; do not deploy or apply a new database migration without a separate production go-ahead.

## Execution packets

- [x] Discovery: map Website and POS order mutation surfaces and check repository state.
- [x] Website: remove UI/API delete pathways and add database-level enforcement.
- [x] POS: remove order delete pathways while retaining cancellation.
- [ ] Website UX: responsive shadcn operator, auth, account, and sticky menu-search updates.
- [ ] Integration: verify cancellation remains possible and no delete surface remains.
- [ ] Release: inspect scoped diffs, run checks, commit, and push the two repositories.

## Single-risk item

Database enforcement is an additive migration and will be committed but not applied to production during this task unless explicitly requested.
