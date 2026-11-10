# reviewchecklist-gerrit-plugin

Gerrit plugin that adds a review checklist to the reply dialog of a change. Tested with Gerrit 3.14.

- The checklist is configured per repository and branch with a `.review-checklist.json` file.
- Mandatory items can block votes, e.g. `Code-Review +2`, until they are checked.
- The state of the checklist is stored in the review message of each reply, so it is visible in the change log and can be evaluated by review reports.

## Installation

Copy `plugins/reviewchecklist-plugin.js` into the `plugins` folder of your Gerrit site. Gerrit loads it automatically after `plugins.checkFrequency` has elapsed; then reload the page.

## Configuration

Add a file named `.review-checklist.json` to the **target branch** of the repository (e.g. `master`). Repositories or branches without this file show no checklist.

### Simple example

```json
[
    {"checkpoint": "Check out change", "mandatory": true},
    {"checkpoint": "Test code", "mandatory": true},
    {"checkpoint": "Do other stuff"}
]
```

Both mandatory items must be checked before you can vote `Code-Review +2`.

### Full example

```json
[
    {"id": "checkout", "checkpoint": "Check out change", "mandatory": true, "label": "Code-Review", "threshold": 2},
    {"id": "verify", "checkpoint": "Verified change", "mandatory": true, "label": "Verified", "threshold": 1},
    {"id": "test", "checkpoint": "Test code", "mandatory": true, "resetOnNewPatchset": true},
    {"id": "other", "checkpoint": "Do other stuff"}
]
```

- `Code-Review +2` requires "Check out change" and "Test code".
- `Verified +1` requires "Verified change".
- "Test code" must be checked again after a new patch set with code changes.

### Item properties

| Property | Required | Default | Description |
|---|---|---|---|
| `checkpoint` | yes | | Text of the checklist item. Line breaks are shown in the dialog and written as one line into the review message. |
| `id` | no | | Stable identifier (letters, digits, `_`, `.`, `-`; unique). The state is matched by id, so the text can be changed later without losing it. |
| `mandatory` | no | `false` | An unchecked mandatory item prevents votes of `threshold` or higher on `label`. |
| `label` | no | `Code-Review` | Label restricted by this mandatory item. |
| `threshold` | no | `2` | Lowest vote that is restricted (integer ≥ 1). The vote is reduced to `threshold - 1`. |
| `resetOnNewPatchset` | no | `false` | The item is unchecked again when a new patch set is uploaded. It is kept for trivial rebases, commit message changes and other patch sets without code changes. |

If several unchecked mandatory items restrict the same label, the lowest threshold applies.

### Defaults for all items

Instead of an array, the file may contain an object. Its `label` and `threshold` are the defaults for all items that do not set their own:

```json
{
    "label": "Verified",
    "threshold": 1,
    "items": [
        {"checkpoint": "Run integration tests", "mandatory": true},
        {"checkpoint": "Check code style", "mandatory": true, "label": "Code-Review", "threshold": 2}
    ]
}
```

### Invalid configuration

If the file exists but is invalid (broken JSON, missing `checkpoint`, duplicate `id`, wrong types, …), the reply dialog shows an error message instead of the checklist.

## Behaviour

- **Reply dialog:** if you choose a vote that unchecked mandatory items do not allow, it is downgraded immediately. A red banner names the downgraded votes, and the blocking items are highlighted until they are checked.
- **Quick approve:** the `Code-Review+2` action button and the vote buttons in the submit requirement hovercard open the reply dialog instead of voting, as long as mandatory items are unchecked.
- **Sending:** the votes are checked again, and the checklist state is appended to the review message:

  ```
  Review checklist:
  [X] Check out change {#checkout}
  [X] Verified change {#verify}
  [ ] Test code {#test}
  [ ] Do other stuff {#other}
  ```

  Items without `id` are written without the `{#...}` suffix. When the dialog is opened again, the state is read from your latest review message.

## Limitations

The restriction is enforced in the Gerrit web UI only. Votes via the REST API, SSH (`gerrit review`) or push options are not checked.
