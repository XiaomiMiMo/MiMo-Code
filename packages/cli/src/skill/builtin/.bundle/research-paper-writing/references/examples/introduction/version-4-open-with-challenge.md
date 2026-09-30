# Introduction Version 4: Open with Application and Challenge


`Version 4: If the task is familiar, introduce applications directly and expose the target technical challenge in the opening paragraph via previous methods.`

Expert notes (faithful translation):

1. It is often good if the opening paragraph already states what we want to solve.
2. But this style requires suitable conditions and is less common.
3. Usually, several prior-method paragraphs are still needed before the target challenge becomes clear.

```latex
% Introduce Application
%% Example 1: Reconstructing 3D scenes from multi-view images is a cornerstone of many applications such as augmented reality, robotics, and autonomous driving.
%% Example 2: Instance segmentation is the cornerstone of many computer vision tasks, such as video analysis, autonomous driving, and robotic grasping, which require both accuracy and efficiency.

% Use previous methods to expose the target technical challenge
%% Example 1: Given input images, traditional methods [43, 44, 59] generally estimate the depth map for each image based on the multi-view stereo (MVS) algorithms and then fuse estimated depth maps into 3D models. Although these methods achieve successful reconstruction in most cases, they have difficulty in handling low-textured regions, e.g., floors and walls of indoor scenes, due to the unreliable stereo matching in these regions.
%% Example 2: Most of the state-of-the-art instance segmentation methods [18, 27, 5, 19] perform pixel-wise segmentation within a bounding box given by an object detector [36], which may be sensitive to the inaccurate bounding box. Moreover, representing an object shape as dense binary pixels generally results in costly post-processing.
```
