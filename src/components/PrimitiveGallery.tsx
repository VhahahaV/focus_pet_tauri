import { Activity, Coffee, MousePointer2, Sparkles } from "lucide-react";
import { useState } from "react";
import { FilledPieChart, Heatmap, HourlyBars, InputColumns, ProgressRing, StatusTimeline } from "./charts";
import {
  Badge,
  Card,
  GlassSurface,
  HoverCard,
  InsetCard,
  MetricTile,
  MiniMeter,
  PrimaryButton,
  SegmentedControl,
  SemanticCard,
  SliderRow,
  SoftButton,
  Stepper,
  TogglePill,
  type UIStatus,
} from "./ui";

const statuses: UIStatus[] = ["focus", "distracted", "rest", "away", "pet", "privacy", "warning", "error", "neutral"];

export const PrimitiveGallery = () => {
  const [segment, setSegment] = useState("focus");
  const [toggle, setToggle] = useState(true);
  const [step, setStep] = useState(25);
  const [slider, setSlider] = useState(64);
  return (
    <main className="fp-gallery">
      <header><span>DEV / __gallery</span><h1>Focus Pet 设计系统</h1><p>组件状态、图表几何和交互密度的目视回归基准。</p></header>

      <section className="fp-gallery-grid">
        {statuses.map((status) => (
          <SemanticCard status={status} key={status}>
            <Badge status={status} compact>{status}</Badge>
            <h2>{status} surface</h2>
            <p>语义卡片与玻璃表面保持统一的层级、描边和状态色。</p>
            <MiniMeter value={status === "away" ? 28 : 72} max={100} status={status} label={`${status} meter`} />
          </SemanticCard>
        ))}
      </section>

      <Card className="fp-gallery-section">
        <h2>Controls</h2>
        <div className="fp-gallery-controls">
          <SegmentedControl label="状态" value={segment} options={[{ value: "focus", label: "专注" }, { value: "rest", label: "休息" }, { value: "away", label: "暂离" }]} onChange={setSegment} />
          <TogglePill checked={toggle} onCheckedChange={setToggle}>桌面宠物</TogglePill>
          <Stepper label="专注阈值" value={step} min={5} max={60} step={5} suffix="m" onChange={setStep} />
          <SliderRow id="gallery-slider" label="不透明度" value={slider} min={20} max={100} suffix="%" onChange={setSlider} />
          <PrimaryButton><Sparkles size={15} />主要操作</PrimaryButton>
          <SoftButton status="rest"><Coffee size={15} />柔和操作</SoftButton>
        </div>
      </Card>

      <section className="fp-gallery-grid fp-gallery-metrics">
        <MetricTile icon={<Activity size={16} />} value="3h 42m" label="今日专注" status="focus" />
        <MetricTile icon={<MousePointer2 size={16} />} value="1,284" label="输入活动" status="privacy" />
        <InsetCard status="pet" selected><strong>Inset card</strong><small>selected state</small></InsetCard>
        <GlassSurface roleType="stage" status="pet"><strong>Stage glass</strong></GlassSurface>
        <HoverCard status="focus"><strong>Hover card</strong><span>精确详情</span></HoverCard>
      </section>

      <section className="fp-gallery-charts">
        <Card><h2>FilledPieChart</h2><FilledPieChart label="状态分布" primaryValue="68%" primaryDetail="2h 31m" data={[{ id: "focus", label: "专注", value: 68, color: "var(--focus-500)", valueLabel: "68%" }, { id: "distracted", label: "走神", value: 20, color: "var(--distracted-500)", valueLabel: "20%" }, { id: "rest", label: "休息", value: 12, color: "var(--rest-500)", valueLabel: "12%" }]} /></Card>
        <Card><h2>Timeline + Input</h2><StatusTimeline label="状态时间线" domain={{ start: 0, end: 100 }} segments={[{ id: "a", start: 0, end: 44, status: "focus" }, { id: "b", start: 44, end: 63, status: "distracted" }, { id: "c", start: 63, end: 82, status: "rest" }, { id: "d", start: 82, end: 100, status: "away" }]} /><InputColumns label="输入柱" columns={Array.from({ length: 20 }, (_, index) => ({ id: String(index), progress: index / 19, keyboard: (index * 7) % 19, pointer: (index * 11) % 13 }))} /><ProgressRing value={0.68} label="进度 68%" status="focus" /></Card>
        <Card><h2>HourlyBars</h2><HourlyBars label="小时柱" maxValue={60} data={Array.from({ length: 24 }, (_, hour) => ({ id: String(hour), label: String(hour).padStart(2, "0"), focus: (hour * 13) % 42, distracted: (hour * 5) % 14 }))} /></Card>
        <Card><h2>Heatmap</h2><Heatmap label="注意力热力图" columns={12} rows={7} cells={Array.from({ length: 84 }, (_, index) => ({ id: String(index), column: Math.floor(index / 7), row: index % 7, ratio: (index % 10) / 10, intensity: ((index * 7) % 10) / 10, label: `cell ${index}` }))} /></Card>
      </section>
    </main>
  );
};
