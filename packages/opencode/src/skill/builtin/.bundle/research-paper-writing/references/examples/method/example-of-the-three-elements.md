# Example of the Three Elements

This example uses `%` comments as annotations.  
Each `% ...` annotation explains the paragraph(s) immediately below it.

```latex
\begin{quote}
\textbf{Annotation rule.} In this example, each line starting with \% labels the role of the paragraph(s) directly below it.
\end{quote}

\begin{itemize}
\item Module design (data structure)
\item Motivation of this module
\item Technical advantages of this module
\item Module design (forward process)
\end{itemize}

\subsection{3.1. Structured latent codes}

% Module design: introduce the module's data structure
To control the spatial locations of latent codes with the human pose, we anchor these latent codes to a deformable human body model (SMPL) [38]. SMPL is a skinned vertex-based model, which is defined as a function of shape parameters, pose parameters, and a rigid transformation relative to the SMPL coordinate system. The function outputs a posed 3D mesh with 6890 vertices. Specifically, we define a set of latent codes \( Z = \{z_1, z_2, ..., z_{6890}\} \) on vertices of the SMPL model. For the frame \( t \), SMPL parameters \( S_t \) are estimated from the multi-view images \( \{I_t^c \mid c = 1, ..., N_c\} \) using [26]. The spatial locations of the latent codes are then transformed based on the human pose \( S_t \) for the density and color regression. Figure 3 shows an example. The dimension of latent code \( z \) is set to 16 in our experiments.

% Technical advantages of this module
Similar to the local implicit representations [25, 5, 18], the latent codes are used with a neural network to represent the local geometry and appearance of a human. Anchoring these codes to a deformable model enables us to represent a dynamic human. With the dynamic human representation, we establish a latent variable model that maps the same set of latent codes to the implicit fields of density and color at different frames, which naturally integrates observations at different frames.

\subsection{3.2. Code diffusion}

% Motivation of this module
Figure 3(a) shows the process of code diffusion. The implicit fields assign the density and color to each point in the 3D space, which requires us to query the latent codes at continuous 3D locations. This can be achieved with the trilinear interpolation. However, since the structured latent codes are relatively sparse in the 3D space, directly interpolating the latent codes leads to zero vectors at most 3D points. To solve this problem, we diffuse the latent codes defined on the surface to nearby 3D space.

% Module design: introduce module design by describing the module forward process
Inspired by [65, 56, 49], we choose the SparseConvNet [21] to efficiently process the structured latent codes, whose architecture is described in Table 1. Specifically, based on the SMPL parameters, we compute the 3D bounding box of the human and divide the box into small voxels with voxel size of \( 5mm \times 5mm \times 5mm \). The latent code of a non-empty voxel is the mean of latent codes of SMPL vertices inside this voxel. SparseConvNet utilizes 3D sparse convolutions to process the input volume and output latent code volumes with \( 2\times, 4\times, 8\times, 16\times \) downsampled sizes. With the convolution and downsampling, the input codes are diffused to nearby space. Following [56], for any point in 3D space, we interpolate the latent codes from multi-scale code volumes of network layers 5, 9, 13, 17, and concatenate them into the final latent code. Since the code diffusion should not be affected by the human position and orientation in the world coordinate system, we transform the code locations to the SMPL coordinate system.

For any point \( \mathbf{x} \) in 3D space, we query its latent code from the latent code volume. Specifically, the point \( \mathbf{x} \) is first transformed to the SMPL coordinate system, which aligns the point and the latent code volume in 3D space. Then, the latent code is computed using the trilinear interpolation. For the SMPL parameters \( S_t \), we denote the latent code at point \( \mathbf{x} \) as \( \psi(\mathbf{x}, Z, S_t) \). The code vector is passed into MLP networks to predict the density and color for point \( \mathbf{x} \).

\subsection{3.3. Density and color regression}

Figure 3(b) overviews the regression of density and color for any point in 3D space. The density and color fields are represented by MLP networks. Details of network architectures are described in the supplementary material.

% Module design: introduce module design by describing the module forward process
\textbf{Density model.} For the frame \( t \), the volume density at point \( \mathbf{x} \) is predicted as a function of only the latent code \( \psi(\mathbf{x}, Z, S_t) \), which is defined as:

\[
\sigma_t(\mathbf{x}) = M_{\sigma}(\psi(\mathbf{x}, Z, S_t)),
\tag{1}
\]

where \( M_{\sigma} \) represents an MLP network with four layers.

% Module design: introduce the module's data structure
\textbf{Color model.} Similar to [37, 44], we take both the latent code \( \psi(\mathbf{x}, Z, S_t) \) and the viewing direction \( \mathbf{d} \) as input for the color regression. To model the location-dependent incident light, the color model also takes the spatial location \( \mathbf{x} \) as input. We observe that temporally-varying factors affect the human appearance, such as secondary lighting and self-shadowing. Inspired by the auto-decoder [48], we assign a latent embedding \( \ell_t \) for each video frame \( t \) to encode the temporally-varying factors.

% Module design: introduce module design by describing the module forward process
Specifically, for the frame \( t \), the color at \( \mathbf{x} \) is predicted as a function of the latent code \( \psi(\mathbf{x}, Z, S_t) \), the viewing direction \( \mathbf{d} \), the spatial location \( \mathbf{x} \), and the latent embedding \( \ell_t \). Following [51, 44], we apply the positional encoding to both the viewing direction \( \mathbf{d} \) and the spatial location \( \mathbf{x} \), which enables better learning of high frequency functions. The color model at frame \( t \) is defined as:

\[
c_t(\mathbf{x}) = M_c(\psi(\mathbf{x}, Z, S_t), \gamma_d(\mathbf{d}), \gamma_x(\mathbf{x}), \ell_t),
\tag{2}
\]

where \( M_c \) represents an MLP network with two layers, and \( \gamma_d \) and \( \gamma_x \) are positional encoding functions for viewing direction and spatial location, respectively. We set the dimension of \( \ell_t \) to 128 in experiments.

\subsection{3.4. Volume rendering}

% Module design: introduce module design by describing the module forward process
Given a viewpoint, we utilize the classical volume rendering techniques to render the Neural Body into a 2D image. The pixel colors are estimated via the volume rendering integral equation [27] that accumulates volume densities and colors along the corresponding camera ray. In practice, the integral is approximated using numerical quadrature [41, 44]. Given a pixel, we first compute its camera ray \( \mathbf{r} \) using the camera parameters and sample \( N_k \) points \( \{\mathbf{x}_k\}_{k=1}^{N_k} \) along camera ray \( \mathbf{r} \) between near and far bounds. The scene bounds are estimated based on the SMPL model. Then, Neural Body predicts volume densities and colors at these points. For the video frame \( t \), the rendered color \( \hat{C}_t(\mathbf{r}) \) ...
```
