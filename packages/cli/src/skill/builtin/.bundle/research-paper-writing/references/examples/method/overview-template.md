# Method Overview Template


`Overview usually includes setting, core contribution, optional figure pointer, and subsection map.`

```latex
% Overview
% One or two sentences for setting
%% Example 1: Given a sparse multi-view video of a performer, our task is to generate a free-viewpoint video of the performer.
%% Example 2: Given an image, the task of pose estimation is to detect objects and estimate their orientations and translations in the 3D space.

% One or two sentences for core contribution
%% Example 1: We build upon prior work for static scenes [46], to which we add the notion of time, and estimate 3D motion by explicitly modeling forward and backward scene flow as dense 3D vector fields.
%% Example 2: Inspired by [21, 25], we perform object segmentation by deforming an initial contour to match object boundary.
%% Example 3: Inspired by recent methods [29, 30, 36], we estimate the object pose using a two-stage pipeline: we first detect 2D object keypoints using CNNs and then compute 6D pose parameters using the PnP algorithm. Our innovation is in a new representation for 2D object keypoints as well as a modified PnP algorithm for pose estimation.

% If pipeline/framework is novel, point to figure
%% Example: The overview of the proposed model is illustrated in Figure 3.

% Explain what Section 3.1 covers
%% Example 1: Neural Body starts from a set of structured latent codes attached to the surface of a deformable human model (Section 3.1).
%% Example 2: In this section, we first describe how to model 3D scenes with MLP maps (Section 3.1).

% Explain what Section 3.2 covers
%% Example 1: The latent code at any location around the surface can be obtained with a code diffusion process (Section 3.2) and then decoded to density and color values by neural networks (Section 3.3).
%% Example 2: Then, Section 3.2 discusses how to represent volumetric videos with dynamic MLP maps.

% Explain what Section 3.3 covers
%% Example 3: Finally, we introduce some strategies to speed up the rendering process (Section 3.3).
```
