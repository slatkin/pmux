# Spec Delta

## ADDED Requirements

### Requirement: Verified report input

For send-mode reports the backend SHALL provide a verified pane-input primitive beside the unchanged fire-and-forget one. Given a target pane, a one-line text and a unique token, it SHALL type the text only with the pane out of any mode and the token absent from the visible screen, poll for the token, then issue exactly one Enter. Failure before the Enter reports `not-submitted`; an Enter exception reports `unknown`. It SHALL NEVER send an editing key into the target pane.

#### Scenario: Pane in a mode
- **WHEN** the target pane reports `pane_in_mode` `1`
- **THEN** no capture, no input and no Enter is sent, and the result is `not-submitted`

#### Scenario: Token appears
- **WHEN** the visible pane shows the token after the text is typed
- **THEN** exactly one Enter is sent, and the result reports the submission

#### Scenario: Token never appears
- **WHEN** the token is still absent after the poll deadline
- **THEN** no Enter is sent and the result is `not-submitted`

#### Scenario: Poll bounds
- **WHEN** the token has not yet appeared
- **THEN** the mode and the visible pane contents are polled every 100 ms for up to 2 seconds, and both are rechecked once more before the Enter

#### Scenario: Unsubmitted text is left alone
- **WHEN** a poll refuses after the text was typed
- **THEN** the typed text is left in the target pane as it is, and no editing key clears it

#### Scenario: Pane enters a mode mid-poll
- **WHEN** `pane_in_mode` becomes `1` after the text was typed
- **THEN** no Enter is sent and the result is `not-submitted`

#### Scenario: Enter throws
- **WHEN** the Enter call raises after the token was verified
- **THEN** the result is `unknown` and no second Enter is attempted

#### Scenario: Post-Enter captures do not count
- **WHEN** the Enter has been sent
- **THEN** no later pane capture changes the reported result

#### Scenario: Never edits the target
- **WHEN** any step refuses or fails
- **THEN** no Escape, Ctrl-U or other editing key is ever sent to the target pane
