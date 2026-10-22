# Spec Delta

## MODIFIED Requirements

### Requirement: Nudge after the alert
When the alert has fired, the completion nudge SHALL tell the child to end the session with `pmux_done` and the handoff text in its `handoff` parameter. It SHALL NOT say that the last message was already delivered as the report. Without an alert, the nudge text SHALL be the shared reminder text of `pi-extension/pmux/nudge.ts`.

#### Scenario: Nudge text after the alert
- **WHEN** the alert has fired and the completion nudge is delivered
- **THEN** the nudge names `pmux_done` with `handoff` and does not say that the last message was already delivered

#### Scenario: Nudge text without an alert
- **WHEN** the alert has not fired and the completion nudge is delivered
- **THEN** the nudge text is the shared reminder text of `pi-extension/pmux/nudge.ts`
