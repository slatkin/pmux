## ADDED Requirements

### Requirement: Role fallback model key
A role definition MAY set `model-fallback:` in its frontmatter. The value names the alternate model of the role. The extension SHALL ship no default value and SHALL NOT check that the value names an existing model. A blank `model-fallback:` SHALL count as absent. The key has no effect on a launch that does not ask for the fallback.

#### Scenario: Role with a fallback model
- **WHEN** a role's frontmatter sets `model: hyper/glm-5.3-flash` and `model-fallback: opencode-go/glm-5.3-flash`
- **THEN** the role definition holds both values

#### Scenario: Blank key
- **WHEN** a role's frontmatter has `model-fallback:` with no value
- **THEN** the role definition holds no fallback model

#### Scenario: Bundled roles
- **WHEN** the package's bundled roles are read
- **THEN** none of them sets `model-fallback:`

#### Scenario: Normal spawn ignores the key
- **WHEN** `pmux_spawn` starts a role that sets `model-fallback:` without the `fallback` parameter
- **THEN** the child runs on the role's `model`

### Requirement: Spawn on the fallback model
`pmux_spawn` SHALL accept an optional boolean `fallback`. When it is `true`, the child SHALL run on the role's `model-fallback` instead of the role's `model`, and the launch record SHALL hold that model. All other role values SHALL apply as before. The parameter description SHALL say that the parent uses it when its primary model hits API limits or errors, or when the user asks for the fallback or alternate model.

#### Scenario: Spawn on the fallback
- **WHEN** `pmux_spawn` starts agent `worker` with `fallback: true`, and `worker` sets `model-fallback: opencode-go/glm-5.3-flash`
- **THEN** the child launches on `opencode-go/glm-5.3-flash` and the launch record holds that model

#### Scenario: Fallback false
- **WHEN** `pmux_spawn` starts a role with `fallback: false`
- **THEN** the child runs on the role's `model`

#### Scenario: Other role values still apply
- **WHEN** `pmux_spawn` starts a role with `fallback: true`, and the role sets `tools`, `thinking` and `deny-tools`
- **THEN** the child gets the same tools, thinking level and denied tools as a spawn without `fallback`

### Requirement: Fallback needs a fallback model
When `pmux_spawn` is called with `fallback: true` and the role has no `model-fallback`, the call SHALL fail with an error that names the role and `model-fallback`. It SHALL create no pane, write no launch record and start no child.

#### Scenario: Role without a fallback
- **WHEN** `pmux_spawn` is called with agent `scout` and `fallback: true`, and `scout` sets no `model-fallback`
- **THEN** the tool result is an error that names `scout` and `model-fallback`, no pane is created, and no launch record is written

### Requirement: Fallback excludes a model override
When `pmux_spawn` is called with `fallback: true` and a `model` value, the call SHALL fail with an error that says the two conflict. It SHALL create no pane, write no launch record and start no child.

#### Scenario: Both given
- **WHEN** `pmux_spawn` is called with `fallback: true` and `model: "other/model"`
- **THEN** the tool result is an error naming both parameters, and no pane is created

### Requirement: Listing shows the fallback model
`pmux_list` SHALL show a role's `model-fallback` next to its `model`, so the parent can see which roles offer a fallback. A role without `model-fallback` SHALL show no fallback text.

#### Scenario: Role with a fallback
- **WHEN** `pmux_list` lists a role with `model` `hyper/glm-5.3-flash` and `model-fallback` `opencode-go/glm-5.3-flash`
- **THEN** the line for that role shows both models, and marks the second as the fallback

#### Scenario: Role without a fallback
- **WHEN** `pmux_list` lists a role that sets no `model-fallback`
- **THEN** the line for that role shows no fallback text

### Requirement: Resume keeps the launch model
A child launched with `fallback: true` SHALL resume on the model its launch record holds, which is the fallback model. `pmux_resume` SHALL NOT accept a fallback parameter.

#### Scenario: Resume of a fallback child
- **WHEN** `pmux_resume` resumes a session whose launch record holds `opencode-go/glm-5.3-flash`, the model that `fallback: true` selected
- **THEN** the resumed child runs on `opencode-go/glm-5.3-flash`
