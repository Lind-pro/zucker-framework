"""Bounded reaction specifications and RDKit SVG rendering."""

from dataclasses import dataclass
from html import escape
from pydantic import BaseModel, Field


@dataclass(frozen=True)
class ReactionRenderStyle:
    bond_line_width: float | None = None
    padding: float | None = None
    condition_font_family: str = "sans-serif"
    condition_font_size: int = 14
    condition_color: str | None = None
    condition_offset_y: int = 18
    monochrome: bool = False


class ReactionParseError(ValueError):
    pass


class ReactionSpec(BaseModel):
    """反应 SMILES / conditions / title 加长度上限；画布宽高各有硬上限。"""

    reaction_smiles: str = Field(..., description="反应 SMILES，>>分隔反应物→产物", max_length=65536)
    conditions: str | None = Field(None, description="反应条件文字，叠在箭头上", max_length=65536)
    title: str | None = Field(None, max_length=512)
    width: int = Field(600, ge=100, le=4000)
    height: int = Field(250, ge=100, le=4000)


def render_reaction(spec: ReactionSpec, *, style: ReactionRenderStyle | None = None) -> dict[str, str]:
    """Render a reaction; annotation text and attributes are XML-escaped."""
    from rdkit.Chem import AllChem
    from rdkit.Chem.Draw import rdMolDraw2D

    style = style or ReactionRenderStyle()
    reaction = AllChem.ReactionFromSmarts(spec.reaction_smiles, useSmiles=True)
    if reaction is None:
        raise ReactionParseError("Unable to parse reaction SMILES")
    drawer = rdMolDraw2D.MolDraw2DSVG(spec.width, spec.height)
    options = drawer.drawOptions()
    if style.monochrome:
        options.useBWAtomPalette()
    if style.bond_line_width is not None:
        options.bondLineWidth = style.bond_line_width
    if style.padding is not None:
        options.padding = style.padding
    drawer.DrawReaction(reaction)
    drawer.FinishDrawing()
    svg = drawer.GetDrawingText()
    if spec.conditions:
        center_x = spec.width // 2
        center_y = spec.height // 2 - style.condition_offset_y
        fill = f' fill="{escape(style.condition_color, quote=True)}"' if style.condition_color is not None else ""
        text_svg = (
            f'<text x="{center_x}" y="{center_y}" text-anchor="middle" '
            f'font-family="{escape(style.condition_font_family, quote=True)}" '
            f'font-size="{style.condition_font_size}"{fill}>'
            f'{escape(spec.conditions, quote=True)}</text>'
        )
        svg = svg.replace("</svg>", f"{text_svg}</svg>")
    return {"svg": svg}
