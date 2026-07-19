# Neural Body Annotated Figure (Text Conversion)

This file converts the annotated Neural Body figure into reusable writing notes.

## Purpose

Use this mapping to understand how one Method section can explicitly separate:

1. Module motivation
2. Module design (data structure)
3. Module design (forward process)
4. Technical advantages

## Block-by-Block Mapping

### Section 3.1: Structured Latent Codes

1. **Module design (data structure)**
- The paragraph defines structured latent codes anchored to the deformable human model (SMPL).
- It explains what is constructed (latent codes + their anchor positions + frame-dependent transformation by pose).

2. **Technical advantages**
- The paragraph explains why this design works better: dynamic-human representation and cross-frame integration of observations.
- It highlights why anchoring codes to deformable geometry is beneficial.

### Section 3.2: Code Diffusion

1. **Motivation of this module**
- The paragraph states the remaining problem: direct interpolation of sparse structured codes leads to near-zero vectors at many 3D points.
- This motivates diffusion from surface codes to nearby 3D space.

2. **Module design (forward process)**
- The paragraph explains the execution pipeline: build sparse latent volumes, run sparse convolutions, interpolate latent codes at query points, and feed codes to prediction networks.
- This is a canonical input -> steps -> output module description.

### Section 3.3: Density and Color Regression

1. **Module design (forward process) for density model**
- The density paragraph defines how density is regressed from latent code and frame condition.

2. **Module design (data structure) for color model**
- The color paragraph introduces required inputs/embeddings (latent code, view direction, spatial location, temporal embedding).

3. **Module design (forward process) for color model**
- The next paragraph describes how those inputs are encoded and passed into the color MLP for final color prediction.

### Section 3.4: Volume Rendering

1. **Module design (forward process)**
- The paragraph describes ray sampling and volume integration to render image outputs from predicted density/color fields.

## Reusable Writing Pattern from This Figure

For each module subsection, follow this order:

1. `Motivation`: state unresolved challenge and technical reason.
2. `Design-1`: define structure/representation/network.
3. `Design-2`: describe forward process in execution order.
4. `Advantage`: explain why this module improves over alternatives.

## Suggested Paragraph Starters

1. Motivation: `A remaining challenge is ...`
2. Data structure design: `We represent ... with ...`
3. Forward process: `Given [input], we first ... then ... finally ...`
4. Technical advantage: `Compared with previous methods, this design ... because ...`
