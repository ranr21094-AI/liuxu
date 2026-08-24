$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Drawing

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$pngPath = Join-Path $projectRoot 'electron\icon.png'
$icoPath = Join-Path $projectRoot 'electron\icon.ico'

function New-RoundedRectanglePath {
  param(
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height,
    [float]$Radius
  )
  $diameter = $Radius * 2
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-LiuXuBitmap {
  param([int]$Size)
  $scale = $Size / 512.0
  $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $background = New-RoundedRectanglePath 0 0 $Size $Size (116 * $scale)
  $graphics.FillPath([System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#f7f5ef')), $background)

  $backPage = New-RoundedRectanglePath (139 * $scale) (128 * $scale) (249 * $scale) (265 * $scale) (31 * $scale)
  $graphics.FillPath([System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#d9d9d2')), $backPage)

  $frontPage = New-RoundedRectanglePath (112 * $scale) (101 * $scale) (249 * $scale) (265 * $scale) (31 * $scale)
  $graphics.FillPath([System.Drawing.SolidBrush]::new([System.Drawing.Color]::White), $frontPage)
  $outlinePen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#2f332f'), (18 * $scale))
  $outlinePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $graphics.DrawPath($outlinePen, $frontPage)

  $bookmark = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $bookmark.AddPolygon([System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new(196 * $scale, 101 * $scale),
    [System.Drawing.PointF]::new(278 * $scale, 101 * $scale),
    [System.Drawing.PointF]::new(278 * $scale, 252 * $scale),
    [System.Drawing.PointF]::new(237 * $scale, 225 * $scale),
    [System.Drawing.PointF]::new(196 * $scale, 252 * $scale)
  ))
  $graphics.FillPath([System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#c6773d')), $bookmark)

  $linePen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#2f332f'), (18 * $scale))
  $linePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $linePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawLine($linePen, 171 * $scale, 300 * $scale, 303 * $scale, 300 * $scale)
  $graphics.DrawLine($linePen, 171 * $scale, 335 * $scale, 262 * $scale, 335 * $scale)

  $linePen.Dispose()
  $bookmark.Dispose()
  $outlinePen.Dispose()
  $frontPage.Dispose()
  $backPage.Dispose()
  $background.Dispose()
  $graphics.Dispose()
  return $bitmap
}

$large = New-LiuXuBitmap 512
try {
  $large.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $large.Dispose()
}

$iconBitmap = New-LiuXuBitmap 256
$pngStream = [System.IO.MemoryStream]::new()
try {
  $iconBitmap.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes = $pngStream.ToArray()
} finally {
  $pngStream.Dispose()
  $iconBitmap.Dispose()
}

$iconStream = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$writer = [System.IO.BinaryWriter]::new($iconStream)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]1)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]32)
  $writer.Write([uint32]$pngBytes.Length)
  $writer.Write([uint32]22)
  $writer.Write($pngBytes)
} finally {
  $writer.Dispose()
  $iconStream.Dispose()
}

Write-Output "Generated $pngPath"
Write-Output "Generated $icoPath"
