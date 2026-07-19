# Technical Challenge Version 1 (Existing Task, Existing Methods)


`Version 1: For existing tasks with existing methods, discuss the challenge chain from traditional methods to recent methods and finally to the challenge we solve.`

```latex
% Discuss general technical challenges of this task (to lead into recent methods)
%% Example 1: This problem is quite challenging from many perspectives, including object detection under severe occlusions, variations in lighting and appearance, and cluttered background objects.
%% Example 2: This problem is particularly challenging due to the inherent ambiguity on acquiring human geometry, materials and motions from images.
This problem is particularly challenging due to several factors, including [xxx reason], [xxx reason], and [xxx reason].

% Briefly introduce one class of traditional methods, then discuss their technical challenge
%% Example: Traditional methods have shown that pose estimation can be achieved by establishing the correspondences between an object image and the object model.
To overcome these challenges, traditional methods [how they work], [what they achieve].

%% Example: They rely on hand-crafted features, which are not robust to image variations and background clutters.
However, they [technical challenge they face].

% Briefly introduce one class of recent methods 1 (optional), then discuss their challenge
%% Example: Deep learning based methods train end-to-end neural networks that take an image as input and output its corresponding pose.
Recently, [xxx methods] [how they work], [what they achieve].

%% Example: However, generalization remains as an issue, as it is unclear that such end-to-end methods learn sufficient feature representations for pose estimation.
However, they [limitation], because [xxx technical reason].

% Briefly introduce one class of recent methods 2, then discuss their challenge (must lead to our solved challenge)
%% Example: Some recent methods use CNNs to first regress 2D keypoints and then compute 6D pose parameters using the Perspective-n-Point (PnP) algorithm. In other words, the detected keypoints serve as an intermediate representation for pose estimation. Such two-stage approaches achieve state-of-the-art performance, thanks to robust detection of keypoints.
To overcome this challenge, [xxx methods] [how they work], [what they achieve].

%% Example: However, these methods have difficulty in tackling occluded and truncated objects, since part of their keypoints are invisible. Although CNNs may predict these unseen keypoints by memorizing similar patterns, generalization remains difficult.
However, they [limitation], because [xxx technical reason].
```
