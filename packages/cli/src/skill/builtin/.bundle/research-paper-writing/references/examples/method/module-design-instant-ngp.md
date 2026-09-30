# Module Design Example 

This example uses `%` comments as annotations.
Each `% ...` annotation explains the paragraph(s) immediately below it.

```latex
\begin{quote}
\textbf{Annotation rule.} In this example, each line starting with \% labels the role of the paragraph(s) directly below it.
\end{quote}

\begin{itemize}
\item Motivation of this module
\item Module design (data structure)
\item Module design (forward process)
\end{itemize}

\section{3 \quad MULTIRESOLUTION HASH ENCODING}

% Motivation of this module
Given a fully connected neural network \(m(y;\Phi)\), we are interested in an encoding of its inputs \(y=\operatorname{enc}(x;\theta)\) that improves the approximation quality and training speed across a wide range of applications without incurring a notable performance overhead.

% Module design: introduce the module's data structure
Our neural network not only has trainable weight parameters \(\Phi\), but also trainable encoding parameters \(\theta\). These are arranged into \(L\) levels, each containing up to \(T\) feature vectors with dimensionality \(F\). Typical values for these hyperparameters are shown in Table 1. Figure 3 illustrates the steps performed in our multiresolution hash encoding. Each level (two of which are shown as red and blue in the figure) is independent and conceptually stores feature vectors at the vertices of a grid, the resolution of which is chosen to be a geometric progression between the coarsest and finest resolutions \([N_{\min},N_{\max}]\):

\[
N_l := \left\lfloor N_{\min}\cdot b^l \right\rfloor, \tag{2}
\]

\[
b := \exp\!\left(\frac{\ln N_{\max}-\ln N_{\min}}{L-1}\right). \tag{3}
\]

\(N_{\max}\) is chosen to match the finest detail in the training data. Due to the large number of levels \(L\), the growth factor is usually small. Our use cases have \(b\in[1.26,2]\).

% Module design: introduce module design by describing the module forward process
Consider a single level \(l\). The input coordinate \(x\in\mathbb{R}^d\) is scaled by that level's grid resolution before rounding down and up:
\[
\lfloor x_l \rfloor := \lfloor x\cdot N_l \rfloor,\quad
\lceil x_l \rceil := \lceil x\cdot N_l \rceil.
\]

\(\lfloor x_l \rfloor\) and \(\lceil x_l \rceil\) span a voxel with \(2^d\) integer vertices in \(\mathbb{Z}^d\). We map each corner to an entry in the level's respective feature vector array, which has fixed size of at most \(T\). For coarser levels where a dense grid requires fewer than \(T\) parameters, i.e. \((N_l+1)^d \le T\), this mapping is 1:1. At finer levels, we use a hash function \(h:\mathbb{Z}^d\rightarrow\mathbb{Z}_T\) to index into the array, effectively treating it as a hash table, although there is no explicit collision handling. We rely instead on the gradient-based optimization to store appropriate sparse detail in the array, and the subsequent neural network \(m(y;\Phi)\) for collision resolution. The number of trainable encoding parameters \(\theta\) is therefore \(O(T)\) and bounded by \(T\cdot L\cdot F\), which in our case is always \(T\cdot16\cdot2\) (Table 1).

We use a spatial hash function [Teschner et al. 2003] of the form
\[
h(x)=\left(\bigoplus_{i=1}^{d} x_i\pi_i\right)\bmod T, \tag{4}
\]
where \(\oplus\) denotes the bit-wise XOR operation and \(\pi_i\) are unique, large prime numbers. Effectively, this formula XORs the results of a per-dimension linear congruential (pseudo-random) permutation [Lehmer 1951], \emph{decorrelating} the effect of the dimensions on the hashed value. Notably, to achieve (pseudo-)independence, only \(d-1\) of the \(d\) dimensions must be permuted, so we choose \(\pi_1:=1\) for better cache coherence, \(\pi_2=2{,}654{,}435{,}761\), and \(\pi_3=805{,}459{,}861\).

Lastly, the feature vectors at each corner are \(d\)-linearly interpolated according to the relative position of \(x\) within its hypercube, i.e. the interpolation weight is \(w_l := x_l-\lfloor x_l \rfloor\).

Recall that this process takes place independently for each of the \(L\) levels. The interpolated feature vectors of each level, as well as auxiliary inputs \(\xi\in\mathbb{R}^E\) (such as the encoded view direction and textures in neural radiance caching), are concatenated to produce \(y\in\mathbb{R}^{LF+E}\), which is the encoded input \(\operatorname{enc}(x;\theta)\) to the MLP \(m(y;\Phi)\).

\textbf{Performance vs. quality.} Choosing the hash table size \(T\) provides a trade-off between performance, memory and quality. Higher values of \(T\) result in higher quality and lower performance. The memory ...
```
