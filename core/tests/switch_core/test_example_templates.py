"""The example templates under `examples/` are written in version 2 of the
template language, read without a finding, and plan a run."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from switch_core.agent_templates import plan_template
from switch_core.template_lint import lint_template
from switch_core.template_v2 import is_v2_text

EXAMPLES = Path(__file__).resolve().parents[3] / "examples"

MACHINES = [
    {
        "id": "m-laptop",
        "name": "laptop",
        "state": "online",
        "providers": [{"provider": "claude", "installed": True, "auth": "ok"}],
    }
]

INPUTS: dict[str, dict[str, str]] = {
    "agent-templates/jq-expert.template.yaml": {},
    "agent-templates/support-desk.template.yaml": {"team": "acme", "bridge": "Slack"},
    "agent-templates/switch-expert.v2.template.yaml": {"start_in": "new_room"},
    "agent-templates/triage-pair.template.yaml": {"team": "acme", "bridge": "Slack"},
    "room-templates/red-blue-workroom.template.yaml": {
        "task_name": "login",
        "coder_agent": "coder",
        "reviewer_agent": "reviewer",
        "brief": "Fix the login page.",
    },
}


def test_every_example_is_listed():
    found = {str(p.relative_to(EXAMPLES)) for p in EXAMPLES.rglob("*.template.yaml")}
    assert found == set(INPUTS)


@pytest.mark.parametrize("relative", sorted(INPUTS))
def test_example_is_version_2_and_reads_clean(relative: str):
    text = (EXAMPLES / relative).read_text()
    assert is_v2_text(text)
    result = lint_template(text)
    assert result.errors == []
    assert result.warnings == []


@pytest.mark.parametrize("relative", sorted(INPUTS))
def test_example_plans_a_run(relative: str):
    text = (EXAMPLES / relative).read_text()
    plan = plan_template(
        text,
        {},
        INPUTS[relative],
        builtins={"$creator": "ada"},
        machines=MACHINES,
    )
    for agent in plan.new_agents:
        assert (agent.machine, agent.provider) == ("m-laptop", "claude")
        assert agent.directory == "{$agents_dir}/" + agent.name
    assert plan.document is not None
    assert "{" + "agent}" not in plan.document
    assert yaml.safe_load(plan.document)
