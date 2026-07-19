# Pipeline Version 1 (One Contribution, Multiple Advantages)


`Version 1: One contribution with multiple advantages, and one teaser figure to present the basic idea.`

```latex
% In this paper, we propose a novel framework …
%% Example: In this paper, we introduce a novel implicit neural representation for dynamic humans, named Neural Body, to solve the challenge of novel view synthesis from sparse views.
In this paper, we propose a novel framework/representation, named [method name] for [xxx task].

% Teaser for basic idea
%% Example: The basic idea is illustrated in Figure 2.
The basic idea is illustrated in [xxx Figure].

% One-sentence key novelty/contribution (very important ability)
%% Example: For the implicit fields at different frames, instead of learning them separately, Neural Body generates them from the same set of latent codes.
Our innovation is in [one sentence for key novelty].

% Method details
%% Example: Specifically, we anchor a set of latent codes to the vertices of a deformable human model (SMPL in this work), namely that their spatial locations vary with the human pose. To obtain the 3D representation at a frame, we first transform the code locations based on the human pose, which can be reliably estimated from sparse camera views. Then, a network is designed to regress the density and color for any 3D point based on these latent codes. Both the latent codes and the network are jointly learned from images of all video frames during the reconstruction.
Specifically, [how it works in detail].

% Advantage 1
%% Example: This model is inspired by the latent variable model in statistics, which enables us to effectively integrate observations at different frames.
In contrast to previous methods, [our advantage].

% Advantage 2
%% Example: Another advantage of the proposed method is that the deformable model provides a geometric prior (rough surface location) to enable more efficient learning of implicit fields.
Another advantage of the proposed method is that [another advantage].
```
