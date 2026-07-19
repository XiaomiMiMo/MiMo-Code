# Introduction Novel-Task Challenge Decomposition


`For novel tasks without direct methods, decompose the challenge into clear requirement/challenge points.`

```latex
% To achieve xx goal, several requirements must be satisfied (or several challenges must be handled).
%% Example: In this work, our goal is to build a model that captures such object intrinsics from a single image. This problem is challenging for three reasons.

% Describe point 1
%% Example: First, we only have a single image. This makes our work fundamentally different from existing works on 3D-aware image generation models [8, 9, 27, 28], which typically require a large dataset of thousands of instances for training. In comparison, the single image contains at most a few dozen instances, making the inference problem highly under-constrained.

% Describe point 2
%% Example: Second, these already limited instances may vary significantly in pixel values. This is because they have different poses and illumination conditions, but neither of these factors are annotated or known. We also cannot resort to existing tools for pose estimation based on structure from motion, such as COLMAP [35], because the appearance variations violate the assumptions of epipolar geometry.

% Describe point 3
%% Example: Finally, the object intrinsics we aim to infer are probabilistic, not deterministic: no two roses in the natural world are identical, and we want to capture a distribution of their geometry, texture, and material to exploit the underlying multi-view information.
```
