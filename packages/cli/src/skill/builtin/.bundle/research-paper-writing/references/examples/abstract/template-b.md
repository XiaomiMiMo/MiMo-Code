# Abstract Template B Examples (Challenge -> Insight -> Contribution)

```latex
\section{Abstract}
% Task
%% Example 1: In recent years, generative models have undergone significant advancement due to the success of diffusion models.
%% Example 2: This paper addresses the challenge of novel view synthesis for a human performer from a very sparse set of camera views.

% Technical challenge for previous methods (discuss around the technical challenge that we solved)
%% Example 1: The success of these models is often attributed to their use of guidance techniques, such as classifier and classifier-free methods, which provides effective mechanisms to tradeoff between fidelity and diversity. However, these methods are not capable of guiding a generated image to be aware of its geometric configuration, e.g., depth, which hinders the application of diffusion models to areas that require a certain level of depth awareness.
%% Example 2: Some recent works have shown that learning implicit neural representations of 3D scenes achieves remarkable view synthesis quality given dense input views. However, the representation learning will be ill-posed if the views are highly sparse.

% Introduce the insight for solving the challenge in one sentence
%% Example 1: To address this limitation, we propose a novel guidance approach for diffusion models that uses estimated depth information derived from the rich intermediate representations of diffusion models.
%% Example 2: To solve this ill-posed problem, our key idea is to integrate observations over video frames.

% Introduce the technical contribution that implements the insight in one to two sentences (usually mention the technical term/name only, without describing every detailed step. The term should be easy to understand and should not create a jump in reading. This ability is very important for writing a good abstract.)
%% Example 1: To do this, we first present a label-efficient depth estimation framework using the internal representations of diffusion models. At the sampling phase, we utilize two guidance techniques to self-condition the generated image using the estimated depth map, the first of which uses pseudo-labeling, and the subsequent one uses a depth-domain diffusion prior.
%% Example 2: To this end, we propose Neural Body, a new human body representation which assumes that the learned neural representations at different frames share the same set of latent codes anchored to a deformable mesh

% Introduce the benefits of technical novelty
%% Example 2: so that the observations across frames can be naturally integrated. The deformable mesh also provides geometric guidance for the network to learn 3D representations more efficiently.

% Experiment
```

## Given example pattern 2

1. `This paper addresses the challenge of novel view synthesis for a human performer from a very sparse set of camera views.`
2. `... representation learning will be ill-posed if the views are highly sparse.`
3. `To solve this ill-posed problem, our key idea is to integrate observations over video frames.`
4. `To this end, we propose Neural Body ...`
5. `... observations across frames can be naturally integrated ... provides geometric guidance ...`
6. `Experiments show [main result].`
