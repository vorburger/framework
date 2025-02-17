# Load ggplot2
library(ggplot2)

# Create a scatterplot with built-in diamonds dataset
my_plot <- ggplot(diamonds, aes(x = carat, y = price, color = cut)) +
  geom_point(alpha = 0.6) +
  labs(
    title = "Diamonds Dataset: Carat vs Price by Cut",
    x = "Carat",
    y = "Price",
    color = "Cut"
  )

# Save as jpeg and write to standard output
ggsave(plot = my_plot, filename = "/dev/stdout", device = "jpeg")
