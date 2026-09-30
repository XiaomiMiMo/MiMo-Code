# Abstract Template C Examples (Multiple Contributions)

```latex
% Task
%% This paper introduces a novel contour-based approach named deep snake for real-time instance segmentation.

%% Unlike some recent methods that directly regress the coordinates of the object boundary points from an image

% Introduce technical contribution and technical advantage in one sentence (this ability is very important for writing a good abstract.)
%% deep snake uses a neural network to iteratively deform an initial contour to match the object boundary, which implements the classic idea of snake algorithms with a learning-based approach.

% Introduce technical contribution and technical advantage in one sentence
%% For structured feature learning on the contour, we propose to use circular convolution in deep snake, which better exploits the cycle-graph structure of a contour compared against generic graph convolution.

% Introduce technical contribution and technical advantage in one sentence
%% Based on deep snake, we develop a two-stage pipeline for instance segmentation: initial contour proposal and contour deformation, which can handle errors in object localization.

% Experiment
```

## Given example pattern (Deep Snake style from your text)

1. `This paper introduces a novel contour-based approach named deep snake for real-time instance segmentation.`
2. `Unlike some recent methods that directly regress the coordinates of the object boundary points from an image ...`
3. `deep snake uses a neural network to iteratively deform an initial contour ...`
4. `For structured feature learning on the contour, we propose circular convolution ...`
5. `Based on deep snake, we develop a two-stage pipeline ...`
6. `Experiments show [main result].`
