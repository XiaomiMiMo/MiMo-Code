# Pipeline Version 2 (Two Contributions)


`Version 2: Two contributions, and one teaser figure to present the basic idea.`

```latex
% In this paper, we propose a novel framework …
%% Example: In this paper, we introduce a novel implicit neural representation for dynamic humans, named Neural Body, to solve the challenge of novel view synthesis from sparse views.
In this paper, we propose a novel framework/representation, named [method name] for [xxx task].

% One-sentence key novelty
%% Example: To that end, we propose techniques to represent a given subject with rare token identifiers and fine-tune a pre-trained, diffusion-based text-to-image framework that operates in two steps; generating a low-resolution image from text and subsequently applying super-resolution (SR) diffusion models.
Our innovation is in [one sentence for key novelty].

% Teaser
%% Example: The basic idea is illustrated in Figure 2.
The basic idea is illustrated in [xxx Figure].

% Contribution 1 details
%% Example: We first fine-tune the low-resolution text-to-image model with the input images and text prompts containing a unique identifier followed by the class name of the subject (e.g., “A [V] dog”).
Specifically, [how contribution 1 works].

% Advantage of contribution 1
%% Example: This model is inspired by the latent variable model in statistics, which enables us to effectively integrate observations at different frames.
In contrast to previous methods, [advantage of contribution 1].

% Challenge motivating contribution 2
%% Example: In order to prevent overfitting and language drift [35, 40] that cause the model to associate the class name (e.g., “dog”) with the specific instance
However, [another technical challenge].

% Contribution 2 details
%% Example: we propose an autogenous, class-specific prior preservation loss, which leverages the semantic prior on the class that is embedded in the model, and encourages it to generate diverse instances of the same class as our subject.
Specifically, [how contribution 2 works].
```
