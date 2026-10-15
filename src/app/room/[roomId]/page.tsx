import RoomView from '@/components/RoomView';

export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomView roomId={roomId} />;
}
