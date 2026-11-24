// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Badge, Button, Card, ConnectionStatus, EmptyState, Input, MetricCard, Skeleton } from "@/components/ui";

describe("ui primitives", () => {
  it("renders Card children and Button text", () => {
    render(
      <Card>
        <Button>Smoke button</Button>
      </Card>,
    );
    expect(screen.getByRole("button", { name: "Smoke button" })).toBeInTheDocument();
  });

  it("Button is disabled when disabled and fires onClick otherwise", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button disabled onClick={onClick}>
        Off
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Off" });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    rerender(<Button onClick={onClick}>On</Button>);
    fireEvent.click(screen.getByRole("button", { name: "On" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Button renders primary, outline and ghost variants and submit type", () => {
    render(
      <>
        <Button variant="primary" type="submit">
          P
        </Button>
        <Button variant="outline">O</Button>
        <Button variant="ghost">G</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "P" })).toHaveAttribute("type", "submit");
    expect(screen.getByRole("button", { name: "O" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "G" })).toBeInTheDocument();
  });

  it("Badge renders every tone", () => {
    const { container } = render(
      <>
        <Badge tone="zinc">z</Badge>
        <Badge tone="green">g</Badge>
        <Badge tone="red">r</Badge>
        <Badge tone="amber">a</Badge>
        <Badge tone="blue">b</Badge>
        <Badge>default</Badge>
      </>,
    );
    expect(container.textContent).toBe("zgrabdefault");
  });

  it("ConnectionStatus maps status to tone text", () => {
    const { rerender } = render(<ConnectionStatus status="ACTIVE" />);
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
    rerender(<ConnectionStatus status="NEEDS_REAUTH" />);
    expect(screen.getByText("NEEDS_REAUTH")).toBeInTheDocument();
    rerender(<ConnectionStatus status="EXPIRED" />);
    expect(screen.getByText("EXPIRED")).toBeInTheDocument();
    rerender(<ConnectionStatus status="BROKEN" />);
    expect(screen.getByText("BROKEN")).toBeInTheDocument();
  });

  it("Input forwards props and value changes", () => {
    const onChange = vi.fn();
    render(<Input placeholder="Name" value="x" onChange={onChange} />);
    expect(screen.getByPlaceholderText("Name")).toHaveValue("x");
  });

  it("Skeleton, EmptyState and MetricCard render with and without optional parts", () => {
    const { container, rerender } = render(
      <>
        <Skeleton />
        <EmptyState title="Nothing here" />
        <MetricCard label="Sites" value="12" />
      </>,
    );
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByText("Sites")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    rerender(
      <>
        <EmptyState title="Nothing here" hint="Add one first" />
        <MetricCard label="Sites" value="12" sub="3 active" />
      </>,
    );
    expect(screen.getByText("Add one first")).toBeInTheDocument();
    expect(screen.getByText("3 active")).toBeInTheDocument();
  });
});
