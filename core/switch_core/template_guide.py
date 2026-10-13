"""The template language, as an agent needs it to write a document.

A condensed ``docs/TEMPLATES.md``, served by the ``get_template_guide``
operation next to the JSON schema of the documents this server accepts. It
covers what the server creates: managed agents, rooms and groups. Keep it in step with the docs
when the language changes; the schema half follows the code by itself.
"""

TEMPLATE_GUIDE = """\
# Switch templates, for agents

A template is one YAML document. You pass it to create_room_from_yaml, save
it with save_template, or run a saved one with run_template.

## Top-level keys

- version: the format version, 1.
- params: the inputs, each written as {name} anywhere else in the document.
- room: one room to create.
- group + rooms (+ links): a room group, its rooms, and links between them.
- kickoff: a message posted into the room once it exists (single room only;
  in a group, put kickoff inside each room entry).
- agent / agents: agents to create, as managed agents on one of the
  deployer's machines. See "An agent" below for what each entry must say.

## A room

room:
  name: text
  description: text              # required
  instructions: text             # standing brief for the room's agents
  bridge: messaging app display name, or "{param}"
  channel_type: channel_public | channel_private
  agents: [agent names that exist on the server]
  users: [usernames on the room's messaging app; "{$creator}" is the deployer]
  aliases: {agent name: alias}   # @alias addresses that agent in this room

Without bridge the room goes on the server's default messaging app. users
needs the room to be on a messaging app.

## An agent

agent:                           # or agents: [ ...the same block... ]
  instructions: text             # REQUIRED. The agent's brief.
  provider: claude | codex | opencode | "{param}"   # REQUIRED (see below)
  machine: machine name or id | "{param}"           # where it runs (see below)
  location: local | ssh host | "{param}"            #   ...or this (see below)
  directory: path | "{param}"                       # REQUIRED (see below)
  name: identifier               # optional; derived from display_name.
                                 # Lowercase letters, digits, . - _
  display_name: text             # optional; how people see it
  description: text              # optional; what it is for
  model: text | "{param}"        # optional; the provider's default if absent
  advanced_config: {key: value}  # optional; see get_advanced_config(provider)
  isolation: shared | isolated   # optional; default shared
  auto_approve: true | false     # optional; default false
  connections:                   # optional; the deployer's connections it gets
    - service: github            #   a service from the deployer's Connections
      access: read | write       #   optional; read by default
      repos: [owner/name]        #   GitHub only: the repositories it reaches
    - atlassian                  #   or just the service's name
  repo: URL                      # optional; the agent clones it into its
                                 # directory. Grants nothing: list a github
                                 # connection for a private one
  sources: [{label, url} or url] # optional; pages it should read
  addressing: owner | owner-agents | anyone   # optional; default owner
  join: [room name or "{param}"] # optional; Console only, rooms it is added to
  allow_existing: true | false   # optional; default false

Running the template creates each agent as a managed agent of the deployer
(your owner, when you run it), on the machine its entry names, before the
rooms. The machine must be online with the provider installed and logged in;
everything is checked before anything is created, and a run that fails
partway deletes the agents it created. You need the "can manage agents"
capability to run one.

provider, where it runs, and directory: nothing fills in what the document
does not say, so every agent must say all three. Write each on the entry, as
a literal or "{param}", or declare a param of that type that no entry's
field reads, which then applies to every agent. A param can offer a choice
with a default: machine default [$first] is the first online machine that
can run the agents' providers; provider default [claude, codex] takes the
first ready on the agent's machine; directory "{$agents_dir}/{agent}" is
the agent's own folder on its machine. Where it runs is one of the
deployer's machines on the server. A location (this computer or an SSH
host) is a Console's idea: it names a machine only when it is one of theirs
by name or id, and otherwise the first online machine that can run the
agent stands in. run_template refuses join. A template missing one is
refused by save_template unless you pass bypass_warnings=true.

connections are the deployer's own (GitHub, Atlassian, ...), granted to the
new agent: the deployer must have connected each, with write access to
grant write. Connections must be on for the server.

allow_existing: true lets the deployer fill this entry with an agent the
server already has instead of creating one: run_template(agents={slot name:
agent name}). Leave it out unless the person asked for that.

In a single agent: document the room refers to the agent as {agent}; in
agents: a room refers to each one by the text written as its name.

Before saving an agent template, settle with the person who asked: which
coding agent runs each agent, on which machine, in which directory (fixed,
or a param with a default they can change), what it may reach
(connections), who may talk to it (addressing), and whether an existing
agent may stand in for it.

## A group

group: {name: text, description: text}
rooms:
  - {name: ..., description: ..., agents: [...], kickoff: "@agent start"}
links:
  - {from: room name, to: room name, label: text}

## Params

params:
  <name>:
    type: string | number | boolean | enum | agent | bridge | room | user
          | provider | machine | location | directory
    description: text
    default: a value, or for agent/bridge/room a list of candidates tried in
             order, where $first means the first one the server has
    required: true | false       # default: false with a single default value,
                                 # true with none or with a list of candidates
    enum: [choices]              # enum only
    pattern: regex               # string only, whole value must match
    min: number, max: number     # number only
    label: text                  # the input's name on the form
    input: ask | advanced | fixed  # shown, folded away, or not editable
    multiline: true | false      # string only, a text area

An agent template may also declare params of type provider, machine,
location and directory; see "An agent". machine and provider take a list of
candidates as their default, like agent/bridge/room.

provider, machine, location and directory params say how the agents are
created and are dropped before the rooms are. In a room or group document
with no agents, leave them out, since the server reads them as text and
requires a value like any other param. Give values in the inputs argument; a required param
with no value is refused with its name.

## Placeholders

{param} is replaced by the param's value; a field that is exactly one
placeholder keeps the value's type. Built in: {$creator} (the deployer, as
the messaging app knows them), {$creator_email}, {$date} (YYYY-MM-DD),
{$timestamp}. A {word} that names nothing is left as written.

## Kickoff

An agent starts working when a message addresses it, so mention each agent
the room needs: kickoff: "@helper start on the brief."
When you create the room, the kickoff speaks for you, not your owner: an
agent that does not accept messages from you makes the request fail before
anything is created. The kickoff also carries the run so far. Asking again
for a room with the same kickoff you already used further up the same path
pauses the run until your owner lets it continue.

## Example

version: 1
params:
  topic: {type: string, description: What the room is about}
room:
  name: "{topic} review"
  description: "Reviewing {topic}"
  agents: [reviewer]
  users: ["{$creator}"]
kickoff: "@reviewer read the brief and list three risks in {topic}."
"""
