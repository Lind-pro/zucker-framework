import unittest
from unittest.mock import patch
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from pydantic import ValidationError
from zucker_framework_render import CircuitSpec, ReactionSpec, MatplotlibSpec, render_reaction, render_plot


class RenderContractTests(unittest.TestCase):
    def test_retains_bounded_inputs(self) -> None:
        with self.assertRaises(ValidationError):
            CircuitSpec.model_validate({"elements": [{"type": "resistor"}] * 201})
        with self.assertRaises(ValidationError):
            ReactionSpec(reaction_smiles="C>>C", width=4001)
        with self.assertRaises(ValidationError):
            MatplotlibSpec.model_validate({"traces": [{"x": [1] * 5001, "y": [1] * 5001}]})

    def test_escapes_reaction_annotations(self) -> None:
        result = render_reaction(ReactionSpec(reaction_smiles="CCO>>CC=O", conditions="a < b & c"))
        self.assertIn("<svg", result["svg"])
        self.assertIn("a &lt; b &amp; c", result["svg"])
        self.assertNotIn("a < b & c", result["svg"])

    def test_returns_trace_metadata_and_closes_figures_on_failure(self) -> None:
        spec = MatplotlibSpec.model_validate({"traces": [{"x": [0, 1], "y": [1, 2]}]})
        before = plt.get_fignums()
        self.assertEqual(render_plot(spec)["traceCount"], 1)
        self.assertEqual(plt.get_fignums(), before)
        with patch("matplotlib.figure.Figure.savefig", side_effect=RuntimeError("failed")):
            with self.assertRaisesRegex(RuntimeError, "failed"):
                render_plot(spec)
        self.assertEqual(plt.get_fignums(), before)


if __name__ == "__main__":
    unittest.main()
