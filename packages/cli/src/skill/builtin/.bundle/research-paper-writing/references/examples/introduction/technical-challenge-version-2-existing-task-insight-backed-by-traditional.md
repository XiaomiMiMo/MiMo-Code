# Technical Challenge Version 2 (Existing Task, Insight Backed by Traditional Methods)


`Version 2: For existing tasks, if our technical insight was used in traditional methods, discuss that line to provide conceptual backing.`

```latex
% Introduce one class of traditional/recent methods and discuss their technical challenge (to lead to our insight)
%% Example (Deep Snake): Most of the state-of-the-art instance segmentation methods perform pixel-wise segmentation within a bounding box given by an object detector.
%% Example (ManhattanSDF): Given input images, traditional methods generally estimate the depth map for each image based on the multi-view stereo (MVS) algorithms and then fuse estimated depth maps into 3D models.
Traditional/recent methods [how they work], [what they achieve].

%% Example (Deep Snake): They may be sensitive to the inaccurate bounding box. Moreover, representing an object shape as dense binary pixels generally results in costly post-processing.
%% Example (ManhattanSDF): Although these methods achieve successful reconstruction in most cases, they have difficulty in handling low-textured regions, e.g., floors and walls of indoor scenes, due to the unreliable stereo matching in these regions.
However, they [limitation], because [xxx technical reason].

% Discuss traditional methods that used an insight similar to ours (implicitly backing our idea)
%% Example (Deep Snake): An alternative shape representation is the object contour, which is a set of vertices along the object silhouette. In contrast to pixel-based representation, a contour is not limited within a bounding box and has fewer parameters. Such a contour-based representation has long been used in image segmentation since the seminal work by Kass et al., which is well known as snakes or active contours.
%% Example (ManhattanSDF): To improve the reconstruction of low-textured regions, a typical approach is leveraging the planar prior of manmade scenes, which has long been explored in literature. A renowned example is the Manhattanworld assumption, i.e., the surfaces of man-made scenes should be aligned with three dominant directions.
To overcome this problem, a typical approach is [xxx insight], which has long been explored in literature.

These methods [how they work].

%% Example (Deep Snake): While many variants have been developed in literature, these methods are prone to local optima as the objective functions are handcrafted and typically nonconvex.
%% Example (ManhattanSDF): However, all of them focus on optimizing per-view depth maps instead of the full scene models in 3D space. As a result, depth estimation and plane segmentation could still be inconsistent among views, yielding suboptimal reconstruction quality as demonstrated by our experimental results in Section 5.3.
However, they [limitation], because [xxx technical reason].

% Then discuss newer methods and their remaining challenge (must lead to our solved challenge)
%% Example: There is a recent trend to represent 3D scenes as implicit neural representations and learn the representations from images with differentiable renderers. In particular, [49, 54, 55] use a signed distance field (SDF) to represent the scene and render it into images based on the sphere tracing or volume rendering. Thanks to the well-defined surfaces of SDFs, they recover high-quality 3D geometries from images.
To overcome this challenge, [xxx methods] [how they work], [what they achieve].

%% Example: However, these methods essentially rely on the multi-view photometric consistency to learn the SDFs. So they still suffer from poor performance in low-textured planar regions, as shown in Figure 1, as many plausible solutions may satisfy the photometric constraint in low-textured planar regions.
However, they [limitation], because [xxx technical reason].
```
